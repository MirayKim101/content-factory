# The MinIO Community repository is source-only. Build the exact upstream
# releases locally instead of relying on an unmaintained third-party image.
ARG GO_IMAGE=golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848
ARG RUNTIME_IMAGE=debian:12.12-slim@sha256:d5d3f9c23164ea16f31852f95bd5959aad1c5e854332fe00f7b3a20fcc9f635c
FROM ${GO_IMAGE} AS build

ARG MINIO_VERSION
ARG MC_VERSION

WORKDIR /src

RUN git clone --depth 1 --branch "${MINIO_VERSION}" https://github.com/minio/minio.git minio \
    && cd minio \
    && test "$(git describe --tags --exact-match)" = "${MINIO_VERSION}" \
    && test "$(git rev-parse HEAD)" = '9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a' \
    && CGO_ENABLED=0 go build -trimpath -ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" -o /out/minio ./ \
    && git clone --depth 1 --branch "${MC_VERSION}" https://github.com/minio/mc.git /src/mc \
    && cd /src/mc \
    && test "$(git describe --tags --exact-match)" = "${MC_VERSION}" \
    && test "$(git rev-parse HEAD)" = '7394ce0dd2a80935aded936b09fa12cbb3cb8096' \
    && CGO_ENABLED=0 go build -trimpath -ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" -o /out/mc ./

FROM ${RUNTIME_IMAGE}

RUN groupadd --gid 10001 minio \
    && useradd --uid 10001 --gid minio --create-home --shell /usr/sbin/nologin minio \
    && mkdir --parents /data \
    && chown minio:minio /data

COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /out/mc /usr/local/bin/mc
COPY healthcheck /usr/local/bin/healthcheck

RUN chmod 0555 /usr/local/bin/minio /usr/local/bin/mc /usr/local/bin/healthcheck

USER minio:minio
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
