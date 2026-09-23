FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ARG API_PROXY=http://host.docker.internal:8001
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
COPY --from=builder --chown=nextjs:nodejs /app/kvm-edge.mjs ./kvm-edge.mjs

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_INNER_PORT=3001
ENV API_PROXY=http://host.docker.internal:8001
CMD ["node", "kvm-edge.mjs"]
