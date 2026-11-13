# Long Tail with the DBOS provider, installed from npm.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build

# Long Tail API, dashboard and relay.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG LONG_TAIL_SPEC=@hotmeshio/long-tail@^0.36.1
RUN echo '{"name":"long-tail-dbos-runtime","private":true}' > package.json \
  && npm install --no-audit --no-fund --ignore-scripts @dbos-inc/dbos-sdk@^5.5.0 pg@^8.23.1 "$LONG_TAIL_SPEC"
COPY --from=builder /app/build ./build
EXPOSE 3000
CMD ["node", "build/start.js"]

# The example DBOS app process (review-order and machine-line). Uses tsx; a real app compiles its own code.
FROM builder AS example
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "examples/server.ts"]
