# Stage 1: Build
FROM --platform=linux/amd64 node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY yarn.lock* ./

# Install dependencies
# If yarn.lock exists, use it; otherwise let yarn create a new one
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi

# Copy source code
COPY . .

# Build the application
RUN yarn build

# Stage 2: Runtime
FROM --platform=linux/amd64 node:20-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copy package files
COPY package.json ./
COPY yarn.lock* ./

# Install production dependencies only
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile --production; else yarn install --production; fi && \
    yarn cache clean

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Change ownership
RUN chown -R nestjs:nodejs /app

USER nestjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application directly (dumb-init may cause exec format error on some platforms)
CMD ["node", "dist/main.js"]

