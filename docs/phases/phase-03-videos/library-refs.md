---
libs:
  "@nestjs/bullmq":
    version: "^12.0.2"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-14T20:31:06-03:00"
  "bullmq":
    version: "^6.7.6"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-14T20:31:06-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-14T20:31:06-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1169.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-14T20:31:06-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T20:23:32-03:00"
---

# Library References — Phase 03 (Upload e Processamento de Vídeos)

Versions were read from the npm registry on 2026-11-14 (`npm view`, run inside the `nestjs-api` container) and checked against the installed stack (`@nestjs/common@^11.0.1`, TypeScript `^5.7.3`). Docs excerpts come from context7. Nothing is installed yet — `package.json` is untouched until `implement`.

Compatibility check: `@nestjs/bullmq@12.0.2` declares peers `@nestjs/common ^10 || ^11 || ^12` and `bullmq ^3 || ^4 || ^5 || ^6`, so it accepts both Nest 11 and `bullmq@6.7.6`.

## Non-npm infrastructure (Compose images)

| Component | Image / source | Evidence |
|-----------|----------------|----------|
| Object storage (TD-01) | `bitnamilegacy/minio:2025.7.23` (MinIO `RELEASE.2025-07-23T15-54-02Z`, go1.24.2) | Manifest resolves; container started and answered `200` on `/minio/health/live`; full spike below passed. Env: `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`; API on `9000`. Upstream archived, image unpatched — local/dev only. |
| Queue broker (TD-03) | `redis:7-alpine` | Manifest resolves (`docker manifest inspect`). Needs AOF persistence configured in Compose so queued jobs survive a restart (TD-03 con). |
| FFmpeg/ffprobe (TD-06/TD-07) | Installed in the **worker** image only. Spike used `jrottenberg/ffmpeg:7-alpine` (FFmpeg 7). | The worker image must provide FFmpeg ≥ 7; the plan must assert `ffmpeg -version` in a test, since the spike ran on the alpine build, not on the final worker base image. |

## Spike results (TD-01 and TD-07 conditional gates) — PASSED

Executed 2026-11-14 on a temporary Docker network, outside the repo, with `@aws-sdk/client-s3@3.1169.0` + `@aws-sdk/s3-request-presigner@3.1169.0`, MinIO above, and a 43 MB / 240 s / 1280x720 H.264 MP4 (`moov` atom at the end — FFmpeg's default MP4 layout). API-side calls used the internal endpoint (`http://minio-spike:9000`); client-facing URLs were signed for `http://localhost:9000` and used from the host with plain `curl` (no SDK, no API in the path).

| Check | Result |
|-------|--------|
| `CreateMultipartUpload` + presigned `UploadPart` URLs signed for the **public** host | OK — signed headers = `host` only |
| 6 parts (5×8 MiB + remainder) `PUT` directly to storage from outside the container network | all `HTTP 200` with `ETag` |
| `ListParts` after upload | 6 parts; **sum of sizes == file size** (total-size verification at completion is feasible, TD-04) |
| `CompleteMultipartUpload` + `HeadObject` | OK, `ContentLength = 42966013`, `video/mp4` |
| Presigned `GET` with `Range: bytes=1000-1999` | `206 Partial Content`, `Content-Range: bytes 1000-1999/42966013`, `Accept-Ranges: bytes` (TD-08) |
| Presigned `GET` with `ResponseContentDisposition: attachment; filename="video.mp4"` | `Content-Disposition` returned (download, TD-08) |
| CORS preflight (`OPTIONS`, `Origin: http://localhost:3001`) | `204`, `Access-Control-Allow-Origin` reflects the origin; actual responses expose `Etag` and `Content-Range` via `Access-Control-Expose-Headers` (default config, no extra setup) |
| `ffprobe` over the presigned URL | exit 0; duration `240.0`, format `mov,mp4`, `h264 1280x720`, bitrate; **312,756 bytes read of 42,966,013 (0.7 %), 2 seeks** |
| Thumbnail `ffmpeg -ss 24 -i <url> -frames:v 1 -vf scale=…` over the presigned URL | exit 0; valid JPEG (26 KB); **4.9 MB read (≈11 %), 2 seeks** |

Conclusions for the plan: (1) TD-01 stands with MinIO; (2) TD-07 Option A (read over HTTP) is viable — the cost is bounded by the index and one GOP, not by file size, so the download fallback (Option C) is **not** needed for this layout; (3) the two-endpoint design of TD-02 is confirmed necessary and sufficient.
Not covered by the spike: a 10 GB object (extrapolated from the byte counts above, not measured) and non-MP4 containers (MKV/WebM) — plan-build should keep the container allowlist small and tested.

## Gotchas found

- **AWS SDK v3 flexible checksums.** Since the 2025 defaults (`requestChecksumCalculation` / `responseChecksumValidation` = `WHEN_SUPPORTED`), the SDK injects checksum behavior into requests and, when presigning `GetObject`, silently sets `ChecksumMode=ENABLED` **[doc]**. Against S3-compatible servers this can add unexpected headers/params to presigned URLs. The spike used `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on both clients and everything worked; keep these settings in the `S3Client` factory unless a test proves they are unnecessary.
- **Presigned URL signs the Host.** The URL signed for `localhost:9000` works from the host and would fail if used with `minio:9000` (and vice-versa); hence the two clients (internal vs public) in TD-02.
- **`forcePathStyle: true`** is required for MinIO/local endpoints (bucket in path, not subdomain) **[doc]**.
- **Presigned PUT/UploadPart URLs are method-bound** — a presigned `GET` URL rejects `HEAD` with `403` (observed). Only sign what the client will actually call.

## Libraries

### @nestjs/bullmq

Used for: producer (`@InjectQueue`) in the API; processor (`@Processor` + `WorkerHost`) in the worker entry point (TD-03, TD-06).

- Async root config with the project's namespaced config (matches the inherited `registerAs` + `ConfigType` convention): `BullModule.forRootAsync({ inject: [...], useFactory: (...) => ({ connection: {...} }) })` **[doc]**.
- Per-queue options and defaults: `BullModule.registerQueueAsync({ name, useFactory, inject })` returning `connection` and `defaultJobOptions: { attempts, backoff }` **[doc]**.
- Inject a queue: `@InjectQueue('name') private readonly queue: Queue` **[doc]**.
- Processor: `@Processor('name', { concurrency })` on a class extending `WorkerHost`, implementing `process(job)`; an error thrown inside `process` fails the job, which is retried per `attempts`/`backoff`, and appears as a `failed` event (`@OnWorkerEvent('failed')`) **[doc]**.
- The worker entry point should bootstrap with `NestFactory.createApplicationContext` (no HTTP server) and rely on Nest shutdown hooks to close workers (BullMQ closes workers gracefully so jobs are not marked stalled) **[doc: bullmq going-to-production]**.

### bullmq

- Custom job id for idempotent enqueue (TD-10): `queue.add(name, data, { jobId })` — "adding a job with an existing id will be ignored"; avoid `:` and digit-only ids **[doc]**. Use the video's public/uuid id (a UUID has no `:`).
- Retries: `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` retries after `2^(attempts-1) * delay` ms **[doc]**.
- Deduplication (alternative to `jobId`): `{ deduplication: { id, ttl? } }` — ignored while the earlier job is not completed/failed **[doc]**. `jobId` is simpler for TD-10 (one job per video).
- Graceful shutdown: `await worker.close()` on `SIGTERM`/`SIGINT` so in-flight jobs are not marked stalled **[doc]**.
- `removeOnComplete` / `removeOnFail` keep Redis from growing unbounded (the project rule `micro-use-queues` shows `removeOnComplete: 1000, removeOnFail: 5000` as defaults).

### @aws-sdk/client-s3

Used for: all server-side storage calls with the **internal** endpoint, and as the command source for presigning with the **public** endpoint (TD-02, TD-04, TD-05, TD-08).

- Client for an S3-compatible server: `new S3Client({ region, endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })` **[doc]** (+ the two checksum settings in "Gotchas").
- Multipart commands used (all verified in the spike): `CreateMultipartUploadCommand`, `UploadPartCommand` (presigned only — bytes never pass through the API), `ListPartsCommand`, `CompleteMultipartUploadCommand` with `MultipartUpload.Parts = [{ PartNumber, ETag }]`, `AbortMultipartUploadCommand` (cleanup, TD-10), `HeadObjectCommand`, `GetObjectCommand`, `CreateBucketCommand`.
- Part numbers are `1..10000`; parts must be consecutive in `CompleteMultipartUpload` **[doc]**; every part except the last must be ≥ 5 MiB **[web: AWS limits, see decisions doc]**.

### @aws-sdk/s3-request-presigner

- `getSignedUrl(client, new Command(input), { expiresIn })`; default `expiresIn` is 900 s **[doc]**.
- Part URL: `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })` — verified.
- Stream URL: `GetObjectCommand({ Bucket, Key })`; download URL: same command with `ResponseContentDisposition: 'attachment; filename="…"'` — verified.
- To force a header to be signed (not needed so far), pass `signableHeaders` / `unhoistableHeaders` **[doc]**; the spike signs only `host`, which is what a plain browser `PUT` needs.
