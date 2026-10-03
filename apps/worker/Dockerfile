# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Node 24.15.0 matches the workspace engine. The index digest keeps both
# linux/amd64 and linux/arm64 builds reproducible.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS source
WORKDIR /workspace
ARG SOURCE_REVISION
COPY . .
RUN SOURCE_REVISION="$SOURCE_REVISION" node --input-type=module -e '\
  import assert from "node:assert/strict"; \
  import { createHash } from "node:crypto"; \
  import { lstatSync, readFileSync, readdirSync } from "node:fs"; \
  const proof = JSON.parse(readFileSync("build-provenance.json")); \
  assert.match(process.env.SOURCE_REVISION ?? "", /^[a-f0-9]{40}$/); \
  assert.equal(proof.commit, process.env.SOURCE_REVISION); \
  const metadata = new Set([".dockerignore", "infrastructure/worker/context-check.Dockerfile"]); \
  const directories = new Map([[".", new Set(["build-provenance.json"])] ]); \
  for (const file of proof.files) { \
    assert.match(file.path, /^[a-zA-Z0-9_./-]+$/); \
    assert.ok(file.path.split("/").every(part => part && part !== "." && part !== ".." && !/^(seanova(?:-new)?|dockerserver)$/i.test(part))); \
    if (metadata.has(file.path)) continue; \
    const parts = file.path.split("/"); \
    let parent = "."; \
    for (const part of parts) { \
      if (!directories.has(parent)) directories.set(parent, new Set()); \
      directories.get(parent).add(part); \
      parent = parent === "." ? part : `${parent}/${part}`; \
    } \
  } \
  for (const [directory, expected] of directories) { \
    assert.deepEqual(readdirSync(directory).sort(), [...expected].sort(), directory); \
    assert.equal(lstatSync(directory).isSymbolicLink(), false); \
  } \
  for (const file of proof.files) { \
    if (metadata.has(file.path)) continue; \
    assert.equal(lstatSync(file.path).isFile(), true, file.path); \
    assert.equal(createHash("sha256").update(readFileSync(file.path)).digest("hex"), file.sha256, file.path); \
  }'

# pnpm is pinned by the root packageManager field. It is installed explicitly
# because Corepack is not part of the runtime contract of the official image.
FROM source AS build
RUN npm install --global pnpm@10.34.5
RUN pnpm install --frozen-lockfile --filter ...@content-factory/worker
RUN pnpm --filter @content-factory/worker build

FROM source AS worker-dependencies
RUN npm install --global pnpm@10.34.5
RUN pnpm install --frozen-lockfile --prod --no-optional --filter ...@content-factory/worker
RUN node --input-type=module -e '\
  import assert from "node:assert/strict"; \
  import { existsSync, readdirSync, readFileSync } from "node:fs"; \
  const forbidden = /^(prisma|@prisma\/(engines|dev|fetch-engine)|typescript|tsx|vitest|oxlint|prettier|turbo|pnpm)$/; \
  const packages = []; \
  for (const entry of readdirSync("node_modules/.pnpm")) { \
    const modules = `node_modules/.pnpm/${entry}/node_modules`; \
    if (!existsSync(modules)) continue; \
    for (const name of readdirSync(modules)) { \
      const names = name.startsWith("@") ? readdirSync(`${modules}/${name}`).map(child => `${name}/${child}`) : [name]; \
      for (const packageName of names) { \
        const path = `${modules}/${packageName}/package.json`; \
        if (!existsSync(path)) continue; \
        const pkg = JSON.parse(readFileSync(path)); \
        assert.equal(forbidden.test(pkg.name), false, pkg.name); \
        packages.push(`${pkg.name}@${pkg.version}`); \
      } \
    } \
  } \
  assert.ok(packages.includes("ioredis@5.11.1")); \
  console.log(JSON.stringify([...new Set(packages)].sort()));'

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
    io.content-factory.promotion="blocked-until-all-release-gates-pass"

ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
ARG DEJAVU_FONT_VERSION=2.37-6

# The Bookworm FFmpeg package is version-pinned; this is not a clean security
# gate. Remove package metadata in the same layer to avoid retaining build state.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" "fonts-dejavu-core=${DEJAVU_FONT_VERSION}" \
    && ffmpeg -version \
    && ffprobe -version \
    && sha256sum /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf > /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf.sha256 \
    && rm -rf /var/lib/apt/lists/*

# Patch only the five reviewed Bookworm packages. Reject any other inventory
# change; this bounded remediation does not make the artifact gate clean.
RUN set -eu; \
    dpkg-query -W -f='${Package}\t${Version}\n' | sort > /tmp/packages.before; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends --only-upgrade \
      libgcrypt20=1.10.1-3+deb12u1 \
      libgnutls30=3.7.9-2+deb12u7 \
      liblzma5=5.4.1-1+deb12u2 \
      libpcre2-8-0=10.42-1+deb12u1 \
      tzdata=2026c-0+deb12u1; \
    dpkg-query -W -f='${Package}\t${Version}\n' | sort > /tmp/packages.after; \
    awk 'NR == FNR { before[$1] = $2; next } !($1 in before) || before[$1] != $2 { print $1 }' \
      /tmp/packages.before /tmp/packages.after | sort > /tmp/packages.changed; \
    awk 'NR == FNR { after[$1] = $2; next } !($1 in after) { print $1 }' \
      /tmp/packages.after /tmp/packages.before | sort > /tmp/packages.removed; \
    printf '%s\n' libgcrypt20 libgnutls30 liblzma5 libpcre2-8-0 tzdata > /tmp/packages.expected; \
    cmp /tmp/packages.expected /tmp/packages.changed; \
    test ! -s /tmp/packages.removed; \
    test "$(dpkg-query -W -f='${Version}' libgcrypt20)" = '1.10.1-3+deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' libgnutls30)" = '3.7.9-2+deb12u7'; \
    test "$(dpkg-query -W -f='${Version}' liblzma5)" = '5.4.1-1+deb12u2'; \
    test "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" = '10.42-1+deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' tzdata)" = '2026c-0+deb12u1'; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /tmp/packages.before /tmp/packages.after /tmp/packages.changed /tmp/packages.removed /tmp/packages.expected

# Final runtime invokes Node directly, never a package manager. Remove only
# verified trees/shims inherited from the pinned base, not application packages.
RUN set -eu; \
    rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22; \
    rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/corepack \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx; \
    for path in \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/corepack \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx; do \
      test ! -e "$path"; \
      test ! -L "$path"; \
    done; \
    test "$(node --version)" = 'v24.15.0'

ENV NODE_ENV=production \
    DEPLOYMENT_PROFILE=other \
    SOURCE_AUTHORIZATION_POLICY=manual \
    WORKER_ROLE=media \
    FFMPEG_THREADS=1 \
    MEDIA_SCRATCH_DIRECTORY=/tmp/media-worker \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    ASSEMBLY_FONT_PATH=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    PUBLISHING_ENABLED=0 \
    YOUTUBE_PUBLISHING_ENABLED=0 \
    TIKTOK_PUBLISHING_ENABLED=0 \
    TWITCH_INGESTION_ENABLED=0 \
    TWITCH_VOD_AUTO_INGEST_ENABLED=0 \
    TWITCH_VOD_MEDIA_GATEWAY_ENABLED=0 \
    VERTICAL_RENDER_ENABLED=0 \
    CLIP_GENERATION_ENABLED=0

WORKDIR /workspace/apps/worker

COPY --from=worker-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=worker-dependencies --chown=node:node /workspace/apps/worker/node_modules ./node_modules
COPY --from=source --chown=node:node /workspace/apps/worker/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/worker/dist ./dist
COPY --from=source --chown=node:node /workspace/packages/contracts/package.json /workspace/packages/contracts/package.json
COPY --from=source --chown=node:node /workspace/packages/contracts/src /workspace/packages/contracts/src
COPY --from=source --chown=node:node /workspace/infrastructure/worker/entrypoint /usr/local/bin/content-factory-media-worker
COPY --from=source --chown=node:node /workspace/infrastructure/worker/healthcheck.mjs /usr/local/bin/content-factory-media-worker-healthcheck.mjs

RUN chmod 0555 /usr/local/bin/content-factory-media-worker \
    /usr/local/bin/content-factory-media-worker-healthcheck.mjs \
    && mkdir --parents /tmp/media-worker \
    && chown node:node /tmp/media-worker \
    && node --input-type=module -e 'await import("@content-factory/contracts")' \
    && node --input-type=module -e '\
      import assert from "node:assert/strict"; \
      import { existsSync, readdirSync, readFileSync } from "node:fs"; \
      const forbidden = /^(prisma|@prisma\/(engines|dev|fetch-engine)|typescript|tsx|vitest|oxlint|prettier|turbo|pnpm)$/; \
      const packages = []; \
      for (const entry of readdirSync("/workspace/node_modules/.pnpm")) { \
        const modules = `/workspace/node_modules/.pnpm/${entry}/node_modules`; \
        if (!existsSync(modules)) continue; \
        for (const name of readdirSync(modules)) { \
          const names = name.startsWith("@") ? readdirSync(`${modules}/${name}`).map(child => `${name}/${child}`) : [name]; \
          for (const packageName of names) { \
            const path = `${modules}/${packageName}/package.json`; \
            if (!existsSync(path)) continue; \
            const pkg = JSON.parse(readFileSync(path)); \
            assert.equal(forbidden.test(pkg.name), false, pkg.name); \
            packages.push(`${pkg.name}@${pkg.version}`); \
          } \
        } \
      } \
      assert.ok(packages.includes("ioredis@5.11.1")); \
      assert.equal(existsSync("/workspace/apps/worker/node_modules/tsx"), false); \
      console.log(JSON.stringify([...new Set(packages)].sort()));' \
    && if /usr/local/bin/content-factory-media-worker node dist/main.js; then exit 1; else test "$?" -eq 78; fi

USER node

ENTRYPOINT ["/usr/local/bin/content-factory-media-worker"]
CMD ["node", "dist/main.js"]
