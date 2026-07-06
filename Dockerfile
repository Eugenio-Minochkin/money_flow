FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

COPY apps apps
COPY packages packages

RUN addgroup -S app && adduser -S -G app app \
    && chown -R app:app /app

ENV NODE_ENV=production
EXPOSE 3000

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/server.js"]
