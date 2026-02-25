# Ghostfolio Agent — production image
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production image
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3334
ENV NODE_ENV=production
ENV PORT=3334

USER node
CMD ["node", "dist/server/main.js"]
