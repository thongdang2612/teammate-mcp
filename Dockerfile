# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript to dist/ ----
FROM node:20-alpine AS build
WORKDIR /app
# Install all deps (incl. dev) for the tsc build. Cache on lockfile.
COPY package.json package-lock.json ./
RUN npm ci
# Compile only src/ (tsconfig includes tests/, but they aren't copied here,
# so tsc simply finds no test files and emits dist/src/**).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: prod deps + compiled output only ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# Diaflow custom-MCP integration requires the HTTP transport. Override at runtime if needed.
ENV MCP_TRANSPORT=http
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Plain `docker run` default. Container hosts (Cloud Run/Render/Fly) inject $PORT,
# which config.ts prefers over MCP_HTTP_PORT.
EXPOSE 8787
USER node
CMD ["node", "dist/src/index.js"]
