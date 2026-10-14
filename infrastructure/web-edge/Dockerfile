# syntax=docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6
# Non-promotable diagnostic target. Use web-edge-build-context.mjs, not checkout.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
WORKDIR /workspace
ARG SOURCE_REVISION
COPY . .
RUN node infrastructure/web-edge/verify-context.mjs "$SOURCE_REVISION"
RUN npm install --global pnpm@10.34.5 \
    && pnpm install --frozen-lockfile --filter @content-factory/web... \
    && pnpm --filter @content-factory/web exec nuxt generate \
    && test -s apps/web/.output/public/index.html \
    && test ! -d apps/web/.output/server

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web-edge
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      io.content-factory.promotion="blocked-until-all-release-gates-pass"
# Remove image download/build helpers; retain the official Caddy binary.
RUN setcap -r /usr/bin/caddy \
    && apk del --no-network curl libcap mailcap \
    && rm -f /usr/share/caddy/index.html \
    && caddy version
COPY --from=build --chown=1000:1000 /workspace/apps/web/.output/public/ /usr/share/caddy/
COPY --from=build /workspace/infrastructure/web-edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/build-provenance.json /usr/share/content-factory/build-provenance.json
USER 1000:1000
WORKDIR /usr/share/caddy
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/bin/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
