FROM node:24-alpine
WORKDIR /app
# dist/ is built by `npm run build -w src/agents` (done by `swarm deploy`).
COPY dist/ ./
USER node
ENV NODE_ENV=production
CMD ["node", "task.mjs"]
