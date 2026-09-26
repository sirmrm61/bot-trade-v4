# ---------- deps ----------
FROM node:24-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# npm's allowScripts gate can defer install/postinstall scripts — rebuild
# native/scripted deps explicitly so better-sqlite3 etc. actually compile
RUN npm ci && npm rebuild better-sqlite3 @prisma/engines esbuild prisma msgpackr-extract unrs-resolver

# ---------- build ----------
FROM node:24-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prisma.config.ts resolves DATABASE_URL at load time — build-only placeholder
ENV DATABASE_URL="file:/tmp/prisma-build.db"
RUN npx prisma generate && npm run build

# ---------- runtime (web) ----------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN groupadd -r app && useradd -r -g app app && mkdir -p /app/data && chown app:app /app/data
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
USER app
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- worker ----------
FROM node:24-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app app && mkdir -p /app/data && chown app:app /app/data
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
USER app
CMD ["npx", "tsx", "src/workers/index.ts"]
