FROM node:18-alpine AS base
WORKDIR /app

# Install deps per-workspace
COPY package.json ./
COPY web/package.json web/package.json
COPY api/package.json api/package.json

RUN npm install --no-audit --no-fund

FROM base AS build
COPY web ./web
COPY api ./api
RUN npm run build

FROM node:18-alpine AS runtime
WORKDIR /app

# Copy built artifacts + production deps
COPY --from=build /app/web /app/web
COPY --from=build /app/api /app/api
COPY --from=build /app/node_modules /app/node_modules
COPY package.json /app/package.json

ENV SERVICE=web
EXPOSE 3000

CMD ["sh", "-c", "if [ \"$SERVICE\" = \"api\" ]; then npm -w api run start; else npm -w web run start; fi"]

