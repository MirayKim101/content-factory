# Media runtime for Stage 1

Verified: 2026-09-09

The future Stage 1 media worker needs Node.js, FFmpeg, and FFprobe in the same
Linux environment. The image built from
`infrastructure/media-runtime/Dockerfile` supplies those tools only; it does
not copy application code or start a worker.

## Pinned inputs

| Input                 | Selected value                                                                                       | Verification                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Node base             | `node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` | Docker pulled the exact `24.15.0-bookworm-slim` tag and reported this digest.       |
| FFmpeg Debian package | `7:5.1.9-0+deb12u1`                                                                                  | `apt-cache policy ffmpeg` in that base image reported it as the Bookworm candidate. |

The [Node Docker Official Image documentation](https://hub.docker.com/_/node)
recommends naming the Debian release explicitly when an image installs extra
packages. The [Debian Bookworm package page](https://packages.debian.org/bookworm/amd64/ffmpeg)
lists the same FFmpeg package version. The Dockerfile installs that exact
version and fails its build if `dpkg-query` reports anything else.

This deliberately uses Debian's maintained package instead of an opaque
third-party FFmpeg image. The old proposed `5.1.9` baseline is now available as
the security-maintained Debian revision `7:5.1.9-0+deb12u1`.

## Build

From the repository root, build the Content Factory image:

```sh
docker build --pull \
  --tag content-factory-media-runtime:node24.15.0-ffmpeg5.1.9 \
  --file infrastructure/media-runtime/Dockerfile \
  infrastructure/media-runtime
```

Expected result: Docker reports the named image was built. No Compose service
uses the image yet. The worker Dockerfile added in the Stage 1 cutting slice
will use this image as its `FROM` base, then copy only its worker build output.

## Isolated runtime smoke test

Run the following after the build. It creates a one-second synthetic H.264 MP4
in an in-memory temporary filesystem, then probes its video stream. The
container has no network, no host mount, and no retained name after exit.

```sh
docker run --rm \
  --name content-factory-media-runtime-smoke \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=1777 \
  content-factory-media-runtime:node24.15.0-ffmpeg5.1.9 \
  /bin/sh -ec '
    node --version
    test "$(id -u)" = 1000
    ffmpeg -hide_banner -version
    ffprobe -hide_banner -version
    ffmpeg -hide_banner -loglevel error \
      -f lavfi -i testsrc2=size=128x72:rate=10 -t 1 \
      -c:v libx264 -pix_fmt yuv420p /tmp/synthetic.mp4
    ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name,width,height,duration \
      -of default=noprint_wrappers=1 /tmp/synthetic.mp4
  '
```

Expected probe output includes `codec_name=h264`, `width=128`, `height=72`, and
`duration=1.000000`. This checks encoding and inspection independently from
the future BullMQ worker, which must still implement job idempotency, status,
failure handling, artifact lineage, and download delivery.

The orchestrator independently repeated this smoke after inspecting the
Dockerfile: unprivileged encoding and probe output matched all four expected
values. Application worker behavior has not been tested by this runtime-only
check.

## Rebuild and rollback

Rebuild only when the pinned base image or FFmpeg package changes through a
reviewed infrastructure change. To return to the current state, remove only
the named image and rebuild from this Dockerfile:

```sh
docker image rm content-factory-media-runtime:node24.15.0-ffmpeg5.1.9
```

This does not modify PostgreSQL, Redis, MinIO, application code, or media
artifacts.
