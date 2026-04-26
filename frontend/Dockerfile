FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY src ./src

EXPOSE 5173
