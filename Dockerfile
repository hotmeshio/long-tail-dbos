# Long Tail with the DBOS provider. Run scripts/pack-long-tail.sh first (vendor/ holds the long-tail package).

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm install --no-audit --no-fund --ignore-scripts && npm install --no-save --no-audit --no-fund ./vendor/hotmeshio-long-tail-*.tgz
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build

# Long Tail API, dashboard and relay.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY vendor ./vendor
# Runtime needs only the two engines; the repo's package.json links long-tail from a sibling checkout.
RUN echo '{"name":"long-tail-dbos-runtime","private":true}' > package.json \
  && npm install --no-audit --no-fund --ignore-scripts @dbos-inc/dbos-sdk@^5.5.0 ./vendor/hotmeshio-long-tail-*.tgz \
  && rm -rf vendor
COPY --from=builder /app/build ./build
EXPOSE 3000
CMD ["node", "build/start.js"]

# The example DBOS app process (review-order). Uses tsx; a real app compiles its own code.
FROM builder AS example
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "examples/review-order/server.ts"]
