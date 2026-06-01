FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

COPY apps apps
COPY packages packages

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "apps/api/src/server.js"]
