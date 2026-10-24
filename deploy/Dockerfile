FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 && pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY apps ./apps
COPY scripts/build-plugin.mjs scripts/finish-web.mjs ./scripts/
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
COPY apps/gateway/src ./apps/gateway/src
COPY scripts/serve-preview.mjs scripts/pairing.mjs scripts/hosted-admin.mjs ./scripts/
COPY --from=build /app/dist/web ./web
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8787 GATEWAY_DATABASE_PATH=/app/data/gateway.sqlite GATEWAY_AUTH_MODE=hosted OCR_PROVIDER=deepseek
EXPOSE 8787
CMD ["node", "scripts/serve-preview.mjs", "--web-root", "web"]
