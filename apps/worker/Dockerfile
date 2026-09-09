# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Node 24.15.0 matches the workspace engine. The index digest keeps both
# linux/amd64 and linux/arm64 builds reproducible.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build

WORKDIR /workspace

# pnpm is pinned by the root packageManager field. It is installed explicitly
# because Corepack is not part of the runtime contract of the official image.
RUN npm install --global pnpm@10.34.5

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# The worker imports the workspace contract from TypeScript source, so tsx is a
# required runtime loader until the contract package publishes JavaScript.
RUN pnpm install --frozen-lockfile --filter ...@content-factory/worker

COPY apps/worker apps/worker
COPY packages/contracts packages/contracts
RUN pnpm --filter @content-factory/worker build

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS runtime

ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
ARG DEJAVU_FONT_VERSION=2.37-6

# Debian Bookworm's security-updated FFmpeg package is version-pinned. Package
# metadata is removed in the same layer so credentials and build state cannot
# leak into the runtime image.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" "fonts-dejavu-core=${DEJAVU_FONT_VERSION}" \
    && ffmpeg -version \
    && ffprobe -version \
    && sha256sum /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf > /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf.sha256 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    MEDIA_SCRATCH_DIRECTORY=/tmp/media-worker \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    ASSEMBLY_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

WORKDIR /workspace/apps/worker

COPY --from=build --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=build --chown=node:node /workspace/apps/worker/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/worker/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/worker/dist ./dist
COPY --from=build --chown=node:node /workspace/packages/contracts /workspace/packages/contracts
COPY --chown=node:node infrastructure/worker/entrypoint /usr/local/bin/content-factory-media-worker
COPY --chown=node:node infrastructure/worker/healthcheck.mjs /usr/local/bin/content-factory-media-worker-healthcheck.mjs

RUN chmod 0555 /usr/local/bin/content-factory-media-worker \
    /usr/local/bin/content-factory-media-worker-healthcheck.mjs \
    && mkdir --parents /tmp/media-worker \
    && chown node:node /tmp/media-worker

USER node

ENTRYPOINT ["/usr/local/bin/content-factory-media-worker"]
CMD ["node", "--import", "tsx", "dist/main.js"]
