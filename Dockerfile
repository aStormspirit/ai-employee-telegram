# syntax=docker/dockerfile:1
# Лёгкий приёмник задач: код, сборка и push выполняются в облачной сессии Claude Code.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV NODE_ENV=production
CMD ["node", "src/index.mjs"]
