# Ghostfolio Agent — production image
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci --ignore-scripts
RUN npx prisma generate

COPY . .
RUN npm run build:server && npm run build:client

# Remove dev source after build
RUN rm -rf src

ENV NODE_ENV=production

CMD ["node", "dist/server/main.js"]
