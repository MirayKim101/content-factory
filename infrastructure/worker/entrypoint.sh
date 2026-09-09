#!/bin/sh
set -eu

# A crash can leave the readiness marker in the persistent scratch volume.
# Remove it before the worker reconnects so the healthcheck cannot report a
# prior process as ready.
rm -f /var/lib/content-factory-worker/worker-ready
exec node apps/worker/dist/main.js
