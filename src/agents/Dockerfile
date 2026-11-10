FROM node:24-alpine
# Chromium for the explorer. The fonts keep rendered text readable; nothing here is run as root.
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont
WORKDIR /app
# dist/ is built by `npm run build -w src/agents` (done by `swarm deploy`); it names the one package
# that stays external (playwright-core, driven against the system Chromium above).
COPY dist/ ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
USER node
ENV NODE_ENV=production \
    SWARM_CHROMIUM_PATH=/usr/bin/chromium-browser \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
CMD ["node", "task.mjs"]
