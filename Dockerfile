# syntax=docker/dockerfile:1

FROM node:24-alpine
WORKDIR /usr/local/WA2DC
ENV WA2DC_TOKEN=CHANGE_THIS_TOKEN
COPY . .
RUN npm ci --omit=dev
ENTRYPOINT ["node", "src/index.js"]
