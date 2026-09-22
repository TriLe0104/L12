FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ARG API_PROXY=http://127.0.0.1:8001
ARG NEXT_PUBLIC_API_BASE=
ENV API_PROXY=$API_PROXY
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV API_PROXY=http://127.0.0.1:8001
# Docker overwrites HOSTNAME with the machine name; Next would then bind
# that name only and 127.0.0.1:3333 would refuse connections.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
