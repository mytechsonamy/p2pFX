# One image for the Node services; docker-compose picks the entrypoint per service.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-core/package.json apps/mock-core/
COPY packages/shared/package.json packages/shared/
COPY packages/pricing/package.json packages/pricing/
COPY packages/matching/package.json packages/matching/
COPY packages/core-adapter/package.json packages/core-adapter/
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
