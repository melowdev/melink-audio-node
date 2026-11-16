FROM node:22.12-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache && npm cache clean --force --cache /tmp/npm-cache

COPY src ./src
ENV NODE_ENV=production
EXPOSE 2333
CMD ["npm", "start"]
