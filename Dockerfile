# Container for any host that can run Docker. Data lives in /data: ATTACH A PERSISTENT DISK THERE.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
