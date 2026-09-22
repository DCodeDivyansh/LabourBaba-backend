# ==============================================================================
# Stage 1: Build & Prune Dependencies
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies deterministically via lockfile
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate client artifacts
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npx prisma generate

# Copy TypeScript configuration and source code to build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Prune development dependencies so node_modules contains production-only packages
RUN npm prune --omit=dev

# ==============================================================================
# Stage 2: Production Runtime
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

# Install wget for container healthcheck
RUN apk add --no-cache wget

# Create non-root user and group (UID/GID 1001)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

ENV NODE_ENV=production
ENV PORT=5000

# Copy only production dependencies, compiled artifacts, and schema
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/prisma.config.ts ./

# Run container as non-root user
USER nodejs

EXPOSE 5000

# Health check using the dependency-aware application /health/ready endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health/ready', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

# Start production API server
CMD ["node", "dist/server.js"]
