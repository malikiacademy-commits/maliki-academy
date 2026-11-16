FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json backend.mjs accounts.mjs notifications.mjs permissions.mjs reports.mjs display-demo.mjs server.mjs seed.json backup.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATABASE_PATH=/data/academy.sqlite PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
