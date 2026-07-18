FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm --filter @matchsense/server deploy --prod --legacy /opt/deploy/server

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DATA_RIGHTS_MODE=txline_hackathon
ENV ROLE=api

WORKDIR /app/server

COPY --from=builder /opt/deploy/server /app/server
COPY --from=builder /workspace/apps/web/dist /app/web/dist

USER node
EXPOSE 8080

CMD ["node", "dist/entry.js"]
