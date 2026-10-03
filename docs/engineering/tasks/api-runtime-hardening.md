# API runtime hardening — diagnostic evidence

Статус: implementation и disposable runtime smoke complete; independent real
diff, provenance/inventory и повторный fresh runtime review CLEAN, 2026-10-03.
Production promotion/deployment не разрешены.

## Scope

Этот bounded slice меняет только final `api-runtime` и `api-migrate` bases.
Builder, application production graph, manifests, lockfile, ADR, worker image,
Compose и runtime configuration не меняются.

Оба final image сохраняют exact parent:
`node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d`.

## Реализованное ограничение

1. Общий final-only runtime layer обновляет ровно пять существующих Bookworm
   packages:

   - `libgcrypt20=1.10.1-3+deb12u1`;
   - `libgnutls30=3.7.9-2+deb12u7`;
   - `liblzma5=5.4.1-1+deb12u2`;
   - `libpcre2-8-0=10.42-1+deb12u1`;
   - `tzdata=2026c-0+deb12u1`.

   Docker build сравнивает полный `dpkg-query` inventory до и после
   транзакции. Любое другое добавление, удаление или изменение package завершает
   build non-zero. Фактический apt result: `5 upgraded, 0 newly installed,
0 to remove`.

2. Migration-only final layer затем добавляет ровно
   `libssl3=3.0.22-1~deb12u1` и `openssl=3.0.22-1~deb12u1`. Второй полный
   inventory diff запрещает любое иное изменение. Фактический apt result:
   `0 upgraded, 2 newly installed, 0 to remove`; OpenSSL сообщил `3.0.22`.

3. Только из final bases удалены глобальные package-manager trees и shims,
   поставляемые parent image: npm/npx, Yarn/yarnpkg и Corepack, включая
   отсутствующие по умолчанию pnpm/pnpx shim paths. Application `node_modules`
   не фильтруется и остаётся результатом frozen `--prod --no-optional` install.
   Build assertion сохраняет `node --version` равным `v24.15.0`.

## Immutable candidate и builds

Рабочее дерево и обычный Git index не использовались как build source. Через
отдельный temporary index создан diagnostic commit object:

- source revision: `61eb28157ec9ecc8242442c9fd77b7edc55cafec`;
- tree: `b68c15c137d2a4e9d5206ad523de47eb8cf01819`;
- closed context: 350 committed regular files;
- API archive: `tmp/api-runtime-hardening-61eb281-api.oci.tar`;
- migrate archive: `tmp/api-runtime-hardening-61eb281-migrate.oci.tar`.

Оба `linux/amd64` targets построены с `--provenance=mode=max` и точным
`SOURCE_REVISION`. Registry push и promotion не выполнялись.

## Disposable runtime proof

Из того же closed context targets были загружены только в local diagnostic
daemon, без registry push:

- `content-factory-api:security-proof-61eb281` —
  `sha256:734aeee302336a13d8b62222d419286a22e3d85ba7fcd07d269b811e1e46ce6e`;
- `content-factory-api-migrate:security-proof-61eb281` —
  `sha256:7be403d21bfe969be27b3586ddb593278f3590ad841a49ea92c2f384c55748ac`.

Обе image labels и embedded `build-provenance.json` указывают только
`61eb28157ec9ecc8242442c9fd77b7edc55cafec`. Runtime inspection подтвердил
`USER node`, UID 1000, Node `v24.15.0`, exact семь package versions и отсутствие
всех заявленных npm/npx, Yarn, Corepack и pnpm/pnpx trees/shims. OpenSSL
отсутствует в API и присутствует только в migrate как `3.0.22`.

Отдельный project `cf-api-security-proof-20261003` использовал fresh disposable
PostgreSQL, Redis и MinIO на единственной internal network, без host ports.
Effective configuration сохранила `MEDIA_QUEUE_DISABLED=1` и 12 external/AI/
publishing flags равными `0`.

Проверки runtime:

1. Fresh migrate применил `45/45`; повторный deploy сообщил отсутствие pending
   migrations, а `migrate status` — schema up to date.
2. Initial readiness вернул `200 {status:"ready"}` с `no-store` за 73 ms;
   final readiness после smoke — за 61 ms. Health вернул dependency-free `200`.
3. Последовательная остановка только project-owned Redis, MinIO и PostgreSQL
   дала generic `DEPENDENCIES_UNAVAILABLE` `503` соответственно за 67, 60 и
   45 ms при неизменном health `200`. Ответы не содержали host, port, provider,
   secret или credential details. После запуска каждой зависимости readiness
   восстановился до `200`.
4. Новый task-owned 2417-byte MP4 с SHA-256
   `354a0fe0aa2ef9ff9e62a8ded93cdbc8ccb6e73d86b4c036ca8573b3ea774b2c`
   прошёл `API_CONTAINER_SMOKE_OK`: manual authorization, idempotent replay,
   checksum/download, Range 206/416, controlled 413/415, scratch cleanup,
   PostgreSQL и BullMQ/ioredis pure-JS duplicate-safe round-trip.

После proof выполнен scoped `down --volumes`: в project осталось 0 containers,
его network удалена. Daemon images и immutable OCI/scan evidence сохранены для
independent review. Другие diagnostic projects и services не затрагивались.

## Offline artifact evidence

Scanner использовал pinned Syft/Trivy, no Docker socket, network `none`,
read-only OCI/DB mounts и полную severity inventory. Trivy DB:

- `UpdatedAt`: `2026-10-03T07:01:46.027466673Z`;
- DB SHA-256: `60b704c31056edb9b6c2ccb271c3837f4ecca531d2da6d79663136f53ba20027`;
- schema: `2`; age at both scans: less than 24 hours.

API evidence:

- archive SHA-256:
  `a018cc9c0e6a37dde1e50b65f1ea8d10b5c27febcc317beb731bebdccec408a9`;
- manifest:
  `sha256:2f607edb61fde70e0541d2a1649fba301a2d05d3d9dba3971310cffbc1095a6e`;
- evidence: `tmp/artifact-scan-9bycKG`;
- blocking findings: 160 (`UNKNOWN=1`, `MEDIUM=102`, `HIGH=53`,
  `CRITICAL=4`), all OS packages;
- recognized LOW: 75.

Migrate evidence:

- archive SHA-256:
  `d84c6deabc64bdd13ceb4e8d9fd149ed2c49ce4ac3216333b6c9cfc6925d91d0`;
- manifest:
  `sha256:1423b2489beac611f09bb87aca37a71a026a6812644b1f6f9368852c5ae5ce1b`;
- evidence: `tmp/artifact-scan-jyHUFc`;
- blocking findings: 170 (`UNKNOWN=1`, `MEDIUM=110`, `HIGH=55`,
  `CRITICAL=4`), all OS packages;
- recognized LOW: 79.

Оба scanner runs ожидаемо завершились exit `1` с
`artifactGatePassed=false` и `promotionApproved=false`. SBOM и vulnerability
inventory не содержат package names `npm`, `corepack` или `yarn`. По сравнению
с предыдущими artifacts blocking count уменьшился с 208 до 160 для API и с
218 до 170 для migrate; это remediation evidence, но не clean artifact gate.

## Оставшиеся обязательные gate

1. Независимый reviewer проверил real diff, candidate provenance, final
   inventory и scanner evidence; отдельно воспроизвёл fresh 45 migrations,
   повторный status, readiness/health и runtime isolation без host ports.
2. Остаточные 160/170 non-LOW findings, два красных source audits и остальные
   ADR-011 gates сохраняют hard deny. Baseline upgrade, exception, publish,
   promotion и deployment этим slice не разрешены.

Rollback до deployment: не использовать diagnostic archives/images и удалить
только task-owned temporary artifacts после сохранения evidence; application
data и существующие services не изменялись.
