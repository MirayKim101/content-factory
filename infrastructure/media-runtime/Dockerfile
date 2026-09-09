# Node 24.15.0 official Debian Bookworm image, pinned to the digest verified on
# 2026-09-09. Bookworm is explicit because this runtime installs Debian media
# packages.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

ARG FFMPEG_DEBIAN_VERSION=7:5.1.9-0+deb12u1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "ffmpeg=${FFMPEG_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show --showformat='${Version}' ffmpeg)" = "${FFMPEG_DEBIAN_VERSION}" \
    && ffmpeg -hide_banner -version \
    && ffprobe -hide_banner -version \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app
USER node

CMD ["node", "--version"]
