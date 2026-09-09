FROM content-factory-media-runtime:node24.15.0-ffmpeg5.1.9 AS build

USER root
WORKDIR /workspace
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable

# Copy manifests before source to preserve the locked dependency-install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/manual-cut/package.json packages/manual-cut/package.json
COPY packages/prisma-client/package.json packages/prisma-client/package.json

RUN pnpm install --frozen-lockfile

# The generated files are compiled outside their API package root. Preserve the
# source package's ESM interpretation without copying the API application.
RUN mkdir --parents apps/api \
    && printf '%s\n' '{"type":"module"}' > apps/api/package.json

# The generated source is committed and is the only Prisma source copied here.
COPY apps/api/src/generated/prisma apps/api/src/generated/prisma
COPY packages/prisma-client packages/prisma-client
COPY packages/manual-cut packages/manual-cut
COPY apps/worker apps/worker

RUN pnpm --filter @content-factory/prisma-client build \
    && pnpm --filter @content-factory/manual-cut build \
    && pnpm --filter @content-factory/worker build \
    && pnpm --filter @content-factory/worker deploy --legacy --prod /workspace/runtime \
    && rm -rf /workspace/runtime/node_modules/@content-factory/manual-cut/src \
        /workspace/runtime/node_modules/@content-factory/manual-cut/test \
    && rm -f /workspace/runtime/node_modules/@content-factory/manual-cut/tsconfig.json \
        /workspace/runtime/node_modules/@content-factory/manual-cut/tsconfig.build.json \
        /workspace/runtime/node_modules/@content-factory/prisma-client/tsconfig.json \
        /workspace/runtime/node_modules/@content-factory/prisma-client/turbo.json

FROM content-factory-media-runtime:node24.15.0-ffmpeg5.1.9

USER root
WORKDIR /app

# The deploy directory contains only production dependencies, including the
# portable workspace dependency tree. The worker source itself is not copied.
COPY --from=build --chown=node:node /workspace/runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/runtime/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node infrastructure/worker/entrypoint.sh /usr/local/bin/worker-entrypoint

RUN mkdir --parents /var/lib/content-factory-worker \
    && chown node:node /var/lib/content-factory-worker \
    && chmod 0555 /usr/local/bin/worker-entrypoint

ENV NODE_ENV=production \
    WORKER_SCRATCH_DIRECTORY=/var/lib/content-factory-worker \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "require('node:fs').accessSync('/var/lib/content-factory-worker/worker-ready')"]

ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
