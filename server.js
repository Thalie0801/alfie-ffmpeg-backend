import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { v4 as uuidv4 } from "uuid";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 512 } }); // 512MB

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", upload.single("frames"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "frames ZIP manquant" });

    const fps = Number(req.body.fps ?? 30);
    const width = Number(req.body.width ?? 1080);
    const height = Number(req.body.height ?? 1920);
    const crf = String(req.body.crf ?? "20");
    const preset = String(req.body.preset ?? "medium");
    const gop = Number(req.body.gop ?? fps * 2);

    const jobId = uuidv4();
    const workdir = path.join(os.tmpdir(), `alfie_ffmpeg_${jobId}`);
    const framesDir = path.join(workdir, "frames");
    const outPath = path.join(workdir, "output.mp4");
    await fs.mkdir(framesDir, { recursive: true });

    await unzipBufferTo(req.file.buffer, framesDir);

    const files = (await fs.readdir(framesDir))
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .sort();

    if (files.length === 0)
      return res.status(400).json({ error: "Aucune image valide trouvée dans le ZIP" });

    await normalizeSequence(framesDir, files);

    const args = [
      "-y",
      "-r", String(fps),
      "-i", path.join(framesDir, "frame_%04d.png"),
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,format=yuv420p`,
      "-c:v", "libx264",
      "-profile:v", "high",
      "-preset", preset,
      "-crf", String(crf),
      "-g", String(gop),
      "-pix_fmt", "yuv420p",
      "-colorspace", "bt709",
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-color_range", "tv",
      "-movflags", "+faststart",
      outPath,
    ];

    await runFFmpeg(args);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="output.mp4"');
    const data = await fs.readFile(outPath);
    res.on("close", () => fs.rm(workdir, { recursive: true, force: true }).catch(() => {}));
    return res.end(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Rendu échoué", detail: String(err?.message || err) });
  }
});

app.listen(process.env.PORT || 8787, () => {
  console.log("FFmpeg render server on :" + (process.env.PORT || 8787));
});

async function unzipBufferTo(buffer, destDir) {
  return new Promise((resolve, reject) => {
    const stream = unzipper.Extract({ path: destDir });
    stream.on("close", resolve);
    stream.on("error", reject);

    const { PassThrough } = await import("node:stream");
    const pass = new PassThrough();
    pass.end(buffer);
    pass.pipe(unzipper.Extract({ path: destDir }))
      .on("close", resolve)
      .on("error", reject);
  });
}

async function normalizeSequence(dir, files) {
  let index = 1;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const target = path.join(dir, `frame_${String(index).padStart(4, "0")}.png`);
    const src = path.join(dir, f);
    if (ext === ".jpg" || ext === ".jpeg") {
      await runFFmpeg(["-y", "-i", src, target]);
      await fs.unlink(src);
    } else if (f !== path.basename(target)) {
      await fs.rename(src, target).catch(async () => {
        const data = await fs.readFile(src);
        await fs.writeFile(target, data);
        await fs.unlink(src);
      });
    }
    index++;
  }
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with ${code}:\n${stderr}`));
    });
  });
}
