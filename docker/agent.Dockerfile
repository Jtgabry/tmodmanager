# syntax=docker/dockerfile:1
# Agent di tModManager: Node + screen + tutto ciò che serve a tModLoader e steamcmd.
# I server di gioco girano DENTRO questo container (sessioni screen avviate dall'agent).

# Add-on di tModManager (plugin TShock, es. LiveMap): .dll indipendenti dalla piattaforma, compilate una volta
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:9.0 AS addons
WORKDIR /src/addons
COPY addons/ ./
RUN bash build.sh

FROM node:22-bookworm-slim AS build
WORKDIR /app/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci
COPY agent/tsconfig.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# screen: console dei server · unzip: release di tModLoader · curl: download di .NET (script di tModLoader)
# tzdata: fuso orario (backup giornaliero dei mondi all'ora locale). /etc/localtime arriva dall'host (compose):
# si toglie il link a UTC dell'immagine, altrimenti il mount finirebbe sul file di UTC
# lib32*: steamcmd è a 32 bit · libicu/libssl: runtime .NET · procps: ps per il debug
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      screen unzip tar ca-certificates curl procps tzdata \
      lib32gcc-s1 lib32stdc++6 libicu72 libssl3 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/localtime /etc/timezone

WORKDIR /app/agent
COPY --from=build /app/agent/node_modules ./node_modules
COPY --from=build /app/agent/dist ./dist
COPY agent/package.json ./
COPY --from=addons /src/addons/dist /app/addons
COPY --chmod=755 docker/agent-entrypoint.sh /usr/local/bin/tmm-agent-entrypoint

ENV NODE_ENV=production \
    TMM_DATA_DIR=/srv/tmm-data \
    AGENT_HOST=0.0.0.0 \
    AGENT_PORT=7878 \
    AGENT_STOP_SERVERS_ON_EXIT=1 \
    AGENT_ADDONS_DIR=/app/addons

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s \
  CMD node -e "fetch('http://127.0.0.1:7878/health').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tmm-agent-entrypoint"]
CMD ["node", "dist/index.js"]
