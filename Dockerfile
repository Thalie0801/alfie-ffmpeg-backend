# Image légère avec ffmpeg installé
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
