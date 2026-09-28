FROM node:22-bookworm-slim

WORKDIR /srv/hermes
COPY package.json ./
COPY app ./app
COPY runner ./runner

ENV NODE_ENV=production \
  PORT=4318 \
  BIND_HOST=0.0.0.0 \
  HERMES_DATA_DIR=/data

RUN mkdir -p /data
EXPOSE 4318
CMD ["node", "app/server.mjs"]
