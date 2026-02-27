FROM node:22-alpine
LABEL build.timestamp="2026-02-27"

WORKDIR /app

RUN apk add --no-cache openssl curl

COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate

COPY . .
RUN npm run build:server && npm run build:client

# Remove source after build to reduce image size
RUN rm -rf src

ENV NODE_ENV=production

CMD ["node", "dist/server/main.js"]
