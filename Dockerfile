FROM node:18-alpine AS base
WORKDIR /app

# Install deps per-workspace
COPY package.json ./
COPY web/package.json web/package.json
COPY api/package.json api/package.json

RUN npm install --no-audit --no-fund

FROM base AS build
# NEXT_PUBLIC_* vars are baked into the Next.js bundle at build time.
# Pass --build-arg NEXT_PUBLIC_API_BASE=https://... when building for a specific environment.
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_PLAN_USE_JOB
ENV NEXT_PUBLIC_PLAN_USE_JOB=$NEXT_PUBLIC_PLAN_USE_JOB
COPY tsconfig.base.json ./
COPY shared ./shared
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

