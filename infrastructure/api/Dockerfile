# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Diagnostic preparation only. Build with export-api-build-context.mjs, never
# from the mutable checkout. Source and image security gates still block promotion.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS migration-base
# Prisma schema engine requires the matching system OpenSSL library. The API
# itself uses the JS PostgreSQL adapter and does not inherit this extra layer.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl=3.0.22-1~deb12u1 libssl3=3.0.22-1~deb12u1 \
    && openssl version \
    && rm -rf /var/lib/apt/lists/*

FROM migration-base AS source
WORKDIR /workspace
ARG SOURCE_REVISION
COPY . .
RUN SOURCE_REVISION="$SOURCE_REVISION" node --input-type=module -e '\
  import assert from "node:assert/strict"; \
  import { readFileSync, readdirSync, lstatSync } from "node:fs"; \
  import { createHash } from "node:crypto"; \
  const proof = JSON.parse(readFileSync("build-provenance.json")); \
  assert.match(process.env.SOURCE_REVISION ?? "", /^[a-f0-9]{40}$/); \
  assert.equal(proof.commit, process.env.SOURCE_REVISION); \
  const directories = new Map([[".", new Set(["build-provenance.json"])]]); \
  for (const file of proof.files) { \
    assert.match(file.path, /^[a-zA-Z0-9_./-]+$/); \
    const parts = file.path.split("/"); \
    assert.ok(parts.every(part => part && part !== "." && part !== ".." && !/^(seanova(?:-new)?|dockerserver)$/i.test(part))); \
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
    assert.equal(lstatSync(file.path).isFile(), true, file.path); \
    assert.equal(createHash("sha256").update(readFileSync(file.path)).digest("hex"), file.sha256, file.path); \
  }'
RUN npm install --global pnpm@10.34.5

FROM source AS build
RUN pnpm install --frozen-lockfile --filter @content-factory/api...
RUN pnpm --filter @content-factory/contracts typecheck \
    && pnpm --filter @content-factory/api build

FROM source AS api-dependencies
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @content-factory/api...
# Inventory the entire store, not just top-level dependency links.
RUN node --input-type=module -e '\
  import assert from "node:assert/strict"; \
  import { readdirSync, readFileSync, existsSync } from "node:fs"; \
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

FROM source AS migration-dependencies
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @content-factory/api-migrate

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS runtime-base
# Patch only the five reviewed Bookworm packages. The package inventory diff
# makes an unexpected dependency addition, removal, or upgrade fail the build.
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
# Final images run Node directly. Remove only the global package-manager trees
# and shims shipped by the pinned official Node image; application dependencies
# remain the untouched frozen pnpm production closure copied below.
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

FROM runtime-base AS migration-runtime-base
# Prisma's schema engine needs these two exact packages. Assert that installing
# them changes no other package in the already-patched runtime base.
RUN set -eu; \
    dpkg-query -W -f='${Package}\t${Version}\n' | sort > /tmp/packages.before; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      libssl3=3.0.22-1~deb12u1 \
      openssl=3.0.22-1~deb12u1; \
    dpkg-query -W -f='${Package}\t${Version}\n' | sort > /tmp/packages.after; \
    awk 'NR == FNR { before[$1] = $2; next } !($1 in before) || before[$1] != $2 { print $1 }' \
      /tmp/packages.before /tmp/packages.after | sort > /tmp/packages.changed; \
    awk 'NR == FNR { after[$1] = $2; next } !($1 in after) { print $1 }' \
      /tmp/packages.after /tmp/packages.before | sort > /tmp/packages.removed; \
    printf '%s\n' libssl3 openssl > /tmp/packages.expected; \
    cmp /tmp/packages.expected /tmp/packages.changed; \
    test ! -s /tmp/packages.removed; \
    test "$(dpkg-query -W -f='${Version}' libssl3)" = '3.0.22-1~deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' openssl)" = '3.0.22-1~deb12u1'; \
    openssl version; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /tmp/packages.before /tmp/packages.after /tmp/packages.changed /tmp/packages.removed /tmp/packages.expected

FROM runtime-base AS api-runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
    io.content-factory.promotion="blocked-until-all-release-gates-pass"
ENV NODE_ENV=production API_HOST=0.0.0.0 PORT=3001 \
    DEPLOYMENT_PROFILE=other SOURCE_AUTHORIZATION_POLICY=manual \
    API_UPLOAD_TEMP_DIRECTORY=/tmp/content-factory-api \
    PUBLISHING_ENABLED=0 YOUTUBE_PUBLISHING_ENABLED=0 TIKTOK_PUBLISHING_ENABLED=0 \
    TWITCH_INGESTION_ENABLED=0 TWITCH_VOD_AUTO_INGEST_ENABLED=0 \
    TWITCH_VOD_MEDIA_GATEWAY_ENABLED=0 VERTICAL_RENDER_ENABLED=0 CLIP_GENERATION_ENABLED=0
WORKDIR /workspace/apps/api
COPY --from=api-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=api-dependencies --chown=node:node /workspace/apps/api/node_modules ./node_modules
COPY --from=api-dependencies --chown=node:node /workspace/apps/api/package.json ./package.json
COPY --from=source --chown=node:node /workspace/packages/contracts/package.json /workspace/packages/contracts/package.json
COPY --from=source --chown=node:node /workspace/packages/contracts/src /workspace/packages/contracts/src
COPY --from=build --chown=node:node /workspace/apps/api/dist ./dist
COPY --from=source /workspace/build-provenance.json /usr/share/content-factory/build-provenance.json
RUN mkdir --parents /tmp/content-factory-api && chown node:node /tmp/content-factory-api
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:3001/api/v1/readiness", {signal: AbortSignal.timeout(2200)}).then(r => {if (!r.ok) process.exitCode=1}).catch(() => {process.exitCode=1})'
CMD ["node", "dist/main.js"]

FROM migration-runtime-base AS api-migrate
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
    io.content-factory.promotion="blocked-until-all-release-gates-pass"
ENV NODE_ENV=production
WORKDIR /workspace/packages/api-migrate
COPY --from=migration-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=migration-dependencies --chown=node:node /workspace/packages/api-migrate/node_modules ./node_modules
COPY --from=source --chown=node:node /workspace/packages/api-migrate/package.json ./package.json
COPY --from=source --chown=node:node /workspace/packages/api-migrate/prisma.config.mjs ./prisma.config.mjs
COPY --from=source --chown=node:node /workspace/apps/api/prisma /workspace/apps/api/prisma
COPY --from=source /workspace/build-provenance.json /usr/share/content-factory/build-provenance.json
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.mjs"]
