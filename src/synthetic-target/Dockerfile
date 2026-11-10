FROM node:24-alpine
WORKDIR /app
# dist/ is built by `npm run build -w src/synthetic-target` (done by `swarm deploy`).
COPY dist/ ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "main.mjs"]
