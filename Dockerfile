# Rewind — record, fork, and replay AI agent runs.
FROM node:24-alpine

WORKDIR /app

# Install workspace dependencies first for layer caching.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4600
# Traces persist here; mount a volume for durability across deploys.
ENV REWIND_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 4600
CMD ["npm", "start"]
