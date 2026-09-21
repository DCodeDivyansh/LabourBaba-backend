# Production Docker Hardening & Multi-Stage Architecture (Issue #35)

## 1. Overview & Security Baseline
The production containerization for LabourBaba Backend is hardened against security vulnerabilities, bloated images, non-deterministic builds, and privileged runtime risks.

### Core Security Guarantees:
1. **Multi-Stage Build**: Separates compile-time development dependencies (TypeScript, Jest, dev types) from the minimal production runtime container.
2. **Deterministic Installation**: Enforces `npm ci` rather than `npm install` to guarantee exact dependency parity with `package-lock.json`.
3. **Production Dependency Isolation**: Executes `npm prune --omit=dev` before copying node_modules to the runner stage.
4. **Non-Root Execution**: Runs strictly under non-root user `nodejs` (`UID 1001`, `GID 1001`).
5. **Container Health Monitoring**: Includes Docker `HEALTHCHECK` probing the `/health` endpoint.
6. **Clean Build Context**: Hardened `.dockerignore` prevents leakage of `.env` files, tests, git history, and scratch logs into the image.

---

## 2. Dockerfile Multi-Stage Structure

```dockerfile
# Stage 1: Build & Prune Dependencies
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production Runtime
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache wget
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs
ENV NODE_ENV=production
ENV PORT=5000
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./

USER nodejs
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["node", "dist/server.js"]
```

---

## 3. Worker vs. API Container Execution
The single hardened image supports both the Express API and standalone BullMQ background workers by overriding the entry command in orchestrators:

- **API Service**: `CMD ["node", "dist/server.js"]` (default)
- **Worker Service**: `CMD ["node", "dist/workers/notificationWorker.js"]`

---

## 4. Verification & Testing
Validated with automated test suite [`tests/dockerHardening.test.ts`](../../tests/dockerHardening.test.ts):
- Verifies multi-stage `builder` and `runner` directives.
- Verifies `npm ci` and `npm prune --omit=dev`.
- Verifies non-root user group and `USER nodejs`.
- Verifies `HEALTHCHECK` with `/health`.
- Verifies `.dockerignore` exclusion rules.
- Verifies pinned `postgis/postgis:17-3.5` image in `docker-compose.yml`.
