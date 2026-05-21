# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN npm install -g pnpm@9

# ── Dependencies ──────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json  ./packages/shared/
RUN pnpm install --frozen-lockfile --filter @contractor/backend... 

# ── Build ─────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules  ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @contractor/shared build 2>/dev/null || true
RUN pnpm --filter @contractor/backend build

# ── Production image ──────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/packages/backend/dist          ./packages/backend/dist
COPY --from=builder /app/packages/backend/node_modules  ./packages/backend/node_modules
COPY --from=builder /app/packages/shared                ./packages/shared
COPY --from=builder /app/node_modules                   ./node_modules
COPY --from=builder /app/packages/backend/drizzle       ./packages/backend/drizzle

EXPOSE 3001
CMD ["node", "packages/backend/dist/server.js"]
