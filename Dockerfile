# Rewind web app + API. Multi-stage: build the UI, ship only runtime deps.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4600 REWIND_DATA_DIR=/data
# tsx (a dev dependency) runs the TypeScript sources, so node_modules ships whole.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/samples ./samples
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s CMD wget -qO- http://127.0.0.1:4600/healthz || exit 1
CMD ["npm", "start"]
