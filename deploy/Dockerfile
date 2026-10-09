FROM node:24-alpine
WORKDIR /app
COPY apps/gateway/src ./apps/gateway/src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8787 GATEWAY_DATABASE_PATH=/app/data/gateway.sqlite
EXPOSE 8787
CMD ["node", "apps/gateway/src/server.ts"]
