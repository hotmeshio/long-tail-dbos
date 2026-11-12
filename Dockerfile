# Long Tail with the DBOS provider.
# Installs @hotmeshio/long-tail from npm, or from vendor/*.tgz when present (scripts/pack-long-tail.sh).

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm install --no-audit --no-fund --ignore-scripts \
  && LT="$(ls ./vendor/*.tgz 2>/dev/null | head -1 || true)" \
  && if [ -n "$LT" ]; then npm install --no-save --no-audit --no-fund "$LT"; fi
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build

# Long Tail API, dashboard and relay.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG LONG_TAIL_SPEC=@hotmeshio/long-tail@^0.35.0
COPY vendor ./vendor
RUN echo '{"name":"long-tail-dbos-runtime","private":true}' > package.json \
  && LT="$(ls ./vendor/*.tgz 2>/dev/null | head -1 || true)" \
  && npm install --no-audit --no-fund --ignore-scripts @dbos-inc/dbos-sdk@^5.5.0 pg@^8.23.1 "${LT:-$LONG_TAIL_SPEC}" \
  && rm -rf vendor
COPY --from=builder /app/build ./build
EXPOSE 3000
CMD ["node", "build/start.js"]

# The example DBOS app process (review-order). Uses tsx; a real app compiles its own code.
FROM builder AS example
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "examples/review-order/server.ts"]
