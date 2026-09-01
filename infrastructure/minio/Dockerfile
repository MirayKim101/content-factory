# The MinIO Community repository is source-only. Build the exact upstream
# releases locally instead of relying on an unmaintained third-party image.
ARG GO_IMAGE=golang:1.24.8-bookworm
ARG RUNTIME_IMAGE=debian:12.12-slim
FROM ${GO_IMAGE} AS build

ARG MINIO_VERSION
ARG MC_VERSION

WORKDIR /src

RUN git clone --depth 1 --branch "${MINIO_VERSION}" https://github.com/minio/minio.git minio \
    && cd minio \
    && test "$(git describe --tags --exact-match)" = "${MINIO_VERSION}" \
    && CGO_ENABLED=0 go build -trimpath -ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" -o /out/minio ./ \
    && git clone --depth 1 --branch "${MC_VERSION}" https://github.com/minio/mc.git /src/mc \
    && cd /src/mc \
    && test "$(git describe --tags --exact-match)" = "${MC_VERSION}" \
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
