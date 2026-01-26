FROM node:lts-alpine

ENV MCP_CLIENT_DOCKER=true

# 🔥 INSTALL DOCKER CLI + COMPOSE
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    bash

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --ignore-scripts
RUN npm rebuild @vscode/ripgrep

COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
