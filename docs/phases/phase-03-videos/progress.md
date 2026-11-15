# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Instalar dependências, configurar namespaces e subir MinIO e Redis no Compose
- **Status:** completed
- **Tests:** 14 passing (src/config; 12 new in env.validation.integration-spec.ts); tsc exit 0; lint exit 0
- **Observations:**
  - MinIO bucket is created by the image via MINIO_DEFAULT_BUCKETS=${S3_BUCKET}; Compose interpolates S3_* keys from the local .env (gitignored, updated by hand — copy new keys from .env.example on a fresh clone).
  - Local .env only received the S3/Redis keys; VIDEO_* keys rely on Joi/config defaults.
  - lint --fix reformatted env.validation.ts (prettier) — no behavior change.
  - Out of scope (unchanged): .env.example MAIL_FROM is unquoted and breaks compose parsing on a fresh clone; local .env has it quoted.

### SI-03.2 — Isolar a infraestrutura de testes e gerar fixtures de vídeo
- **Status:** completed
- **Tests:** 4 passing (test-isolation.integration-spec.ts); full suite after the change: 155 unit/integration + 52 e2e passing; tsc exit 0; lint exit 0
- **Observations:**
  - Baseline defect found: no suite ever set DB_DATABASE, so the whole test suite (incl. cleanAllTables) ran against the development database `streamtube`. Now isolated in `streamtube_test`.
  - globalSetup also runs CREATE EXTENSION "uuid-ossp" on the new DB: the CreateUsersAndChannels migration uses uuid_generate_v4() and TypeORM only installs the extension when entities are loaded.
  - Admin connection for creating the test DB uses DB_NAME (dev DB `streamtube`), as the plan says.
  - Fixtures: sample.mp4 6.9 KB, sample.webm 10.2 KB, sample.mov 6.9 KB; ffprobe confirms h264/vp9 320x240, 2 s. Bucket `streamtube-test` is only named here; creating it is for SI-03.4.

### SI-03.3 — Criar a entidade Video, a migration CreateVideos e as exceções de domínio
- **Status:** completed
- **Tests:** 9 passing in SI scope (video.entity.integration-spec 6, migrations.integration-spec 3); full suite 162 unit/integration + 52 e2e; tsc 0; lint 0
- **Observations:**
  - Channel now references Video, so every test entity array (11 spec files) and AppModule had to know Video: added Video to ALL_ENTITIES in existing specs and created a minimal VideosModule (TypeOrmModule.forFeature([Video])) imported by AppModule so autoLoadEntities finds it; SI-03.6 extends this module.
  - Migration CreateVideos1794708056410 generated with the TypeORM CLI against the migrated dev DB; down drops table, indexes, FK and the videos_status_enum type (verified by test); also applied to the dev DB.
  - migrations.integration-spec now drops videos and videos_status_enum before running; the revert test was split in two (revert CreateVideos, then CreateAuthTokens).
  - Ran jest once without --runInBand by mistake: two suites raced on the shared DB; recreating streamtube_test and rerunning serially passed. Always use --runInBand.

### SI-03.4 — Criar o StorageModule e o StorageService (S3)
- **Status:** completed
- **Tests:** 26 passing (storage.service.spec 16, storage.service.integration-spec 9 against real MinIO, storage.module.spec 1); tsc 0; lint 0
- **Observations:**
  - StorageService.ensureBucket runs in onModuleInit, which is also what creates the test bucket streamtube-test.
  - headObject returns null on 404 and ensureBucket/abort swallow only the specific not-found cases (intentional conversions, per service error rule); every other SDK failure is logged server-side and becomes StorageUnavailableException without leaking SDK text.
  - Integration test covers a real 3-part multipart upload with direct PUTs to presigned URLs, ListParts sum, Range->206, attachment Content-Disposition, abort of a non-existent upload and an unreachable endpoint.

### SI-03.5 — Criar o QueueModule e o produtor de jobs de vídeo
- **Status:** completed
- **Tests:** 5 passing (queue.module.spec 1, video-queue.service.integration-spec 4 against real Redis); manual: job survived docker compose restart redis; tsc 0; lint 0
- **Observations:**
  - Plan deviation: ioredis@^5.11.1 had to be installed — bullmq 6 made it an optional peer dependency and the Queue throws 'could not load ioredis' otherwise.
  - Plan deviation: @nestjs/bullmq 12 and @nestjs/bull-shared are ESM-only; Node 25 loads them via require(esm) but Jest cannot. Added test/esm-to-cjs.transformer.js (typescript.transpileModule) wired in package.json jest and test/jest-e2e.json (transform + transformIgnorePatterns) for those two packages only. Production Node must be >= 22.12.
  - bullmq 6 no longer exposes queue.client; the prefix test uses its own ioredis client.
  - Re-enqueue caveat for SI-03.9: jobId = videoId, and finished jobs are kept (removeOnComplete/Fail counts), so enqueueing an id whose old job still exists is ignored; the sweep must remove a stale failed job before re-enqueueing.

### SI-03.6 — Implementar o fluxo de upload: rascunho, URLs de partes e conclusão
- **Status:** completed
- **Tests:** 30 new unit/integration (public-id.util.spec 3, video-uploads.service.spec 17, videos.service.integration-spec 9, video-uploads.service.integration-spec 1 with DB+MinIO+Redis) + 14 e2e (videos-upload.e2e-spec); full suite 223 unit/integration + 66 e2e at that point; tsc 0; lint 0
- **Observations:**
  - Part size and partCount come from VIDEO_PART_SIZE_BYTES at request time (not stored per video): changing that setting while uploads are in flight would change partCount.
  - markProcessing is one conditional UPDATE (WHERE status='draft') instead of an explicit transaction: atomic and race-safe (test: of two concurrent calls exactly one wins).
  - The draft id is generated in the app (randomUUID) because the storage key embeds videos.id before the row exists; startUpload aborts the multipart upload if the insert fails.
  - part-urls has @Throttle 300/min; POST /videos and /complete keep the global 10/min (e2e clears throttler storage in beforeEach, as auth e2e does).
  - Added ChannelsService.findByUserId and src/common/database/pg-errors.ts (isPgUniqueViolationOnColumn). channels.service.ts still has its own private copy of that helper: deduplicating it is out of scope (follow-up).
  - Fixed along the way: migrations.integration-spec dropped tables with Promise.all + CASCADE and deadlocked once videos (FK to channels) existed — now sequential; jest-global-setup now resets the public schema on every run so a failed run cannot leave leftovers (an orphan enum had broken the e2e globalSetup).

### SI-03.7 — Implementar o worker de vídeo: metadados, thumbnail e ciclo de status
- **Status:** completed
- **Tests:** 30 new unit/integration (media-probe.service.spec, video-processing.processor.integration-spec, worker.module.spec) + 4 new e2e (video-processing.e2e-spec: sample.mp4/webm/mov to ready, text file to NOT_A_VIDEO); full suite 253 unit/integration + 70 e2e; tsc 0; lint 0
- **Observations:**
  - Plan deviation (FFmpeg version): node:25.6.0-slim is Debian bookworm whose ffmpeg package is 5.1, but the plan requires FFmpeg >= 7. Both Dockerfile.worker and Dockerfile.dev copy static ffmpeg/ffprobe 7.1 from mwader/static-ffmpeg:7.1 instead of apt. docker compose exec video-worker ffmpeg -version reports 7.1.
  - Dockerfile.dev (nestjs-api) now also ships ffmpeg/ffprobe: the e2e pipeline test runs the real WorkerModule in-process against the isolated test resources (the compose video-worker uses the dev DB/bucket/queue prefix, so it cannot consume test jobs). The API never calls ffmpeg at runtime.
  - Extracted DatabaseModule and config-module.options.ts (shared by AppModule and WorkerModule). WorkerModule registers Video, Channel and User with forFeature: with autoLoadEntities TypeORM only knows registered entities, and Video -> Channel -> User; missing this made the worker loop on 'Entity metadata for Video#channel was not found'.
  - start:worker uses tsconfig.worker.json (outDir dist-worker) so the worker's nest build does not clobber dist/ used by start:dev; dist-worker is gitignored and excluded from tsconfig.json/tsconfig.worker.json (otherwise the watch rebuild fails with TS5055).
  - Dev gotcha: on Windows bind mounts nest start --watch does not see host file edits; restart the video-worker service after changing code. First compile in the container takes several minutes.
  - Concurrency: @Processor cannot read config (decorator runs before ConfigModule loads .env), so VIDEO_WORKER_CONCURRENCY is applied in onApplicationBootstrap via worker.concurrency.
  - Processing: ffprobe reads over the internal presigned URL; unknown/non-media data (stderr 'Invalid data found') and containers outside mov/mp4/matroska/webm map to NOT_A_VIDEO (UnrecoverableError, no retry); ffprobe/ffmpeg are spawned with argument arrays, timeouts, and the signed URL is redacted from error text.
  - Test hang lesson: worker.module.spec compiled WorkerModule against the real DB; the entity-metadata bug made TypeORM retry forever, hanging jest. Always run long jest invocations with timeout.

### SI-03.8 — Implementar a entrega: status do vídeo, streaming, download e thumbnail
- **Status:** completed
- **Tests:** 19 new unit (video-delivery.service.spec 18, videos.module.spec 1) + 22 new e2e (videos-delivery.e2e-spec); full suite 272 unit/integration + 92 e2e; tsc 0; lint 0
- **Observations:**
  - Express adds a short 'Found. Redirecting to <url>' body to every 302; the e2e asserts it is that notice only (< 2 KB), i.e. no video bytes through the API.
  - Download filenames are sanitized for header safety: quotes, backslashes and control characters removed, non-ASCII replaced by '_' (a raw UTF-8 name in Content-Disposition would show as mojibake); falls back to {publicId}.{ext} when nothing usable remains. StorageService.presignGetObject also escapes quotes as a second line of defence.
  - Throttle: GET /videos/:publicId 60/min; stream, download and thumbnail 120/min (tested: 15 calls in a minute are not 429).
  - Added VideosService.findReadyByPublicId: anonymous delivery only ever sees ready videos, so draft/processing/error answer exactly like unknown ids (404 VIDEO_NOT_FOUND).

### SI-03.9 — Implementar a reconciliação e a limpeza de uploads abandonados
- **Status:** completed
- **Tests:** 13 new (video-maintenance.service.integration-spec 8, video-maintenance.processor.spec 4, video-maintenance.scheduler.integration-spec 1); full suite 285 unit/integration + 92 e2e; tsc 0; lint 0
- **Observations:**
  - VideoQueueService.requeueProcessing added (not in the plan): jobId = videoId and finished jobs are retained, so a plain re-add for a video whose old job is completed/failed would be silently ignored by BullMQ. It leaves waiting/active/delayed jobs alone and removes retained completed/failed ones before re-adding (tested with a real failed job).
  - Finding: this MinIO returns an EMPTY list for ListMultipartUploads when a Prefix is given (without Prefix it lists everything). src/test/clean-storage.ts had therefore never aborted leftover multipart uploads, and my first draft-cleanup assertion would have passed vacuously. Now both list without Prefix and filter client-side; the test also asserts the upload exists before cleanup.
  - The sweep processor runs both routines and, if any failed, throws after both ran so the failure is visible in BullMQ without stopping future scheduled sweeps. Sweeps are bounded to 200 videos per run.
  - Draft cleanup is conditional on status draft in the DELETE, so a video completed while the sweep runs is never removed; a draft whose abort fails is kept and retried next sweep.

### SI-03.10 — Exportar o OpenAPI, atualizar o CLAUDE.md, medir o upload de 10 GiB e fechar a Definition of Done
- **Status:** completed
- **Tests:** 15 new in openapi-export.integration-spec (24 total in file); manual 10 GiB upload passed; final DoD green (see observations)
- **Observations:**
  - openapi.json regenerated with `npm run openapi:export`: the 7 video paths are documented (POST /videos, part-urls, complete, GET status, stream, download, thumbnail). openapi-export.integration-spec gained 15 tests (24 total): the 7 paths/methods, access-token security on the 4 protected routes, public + 302 on the 3 delivery routes, and a drift guard that fails when the export differs from the committed openapi.json.
  - Both CLAUDE.md files updated (nestjs-project/CLAUDE.md: services, FFmpeg 7.1, commands, isolated test resources, jest config, env variables and the S3_PUBLIC_ENDPOINT localhost exception, video module/lifecycle/routes/rate limits, smoke script; root CLAUDE.md: architecture bullets, Docker networking exception). Every file path and npm script they cite was checked to exist. The ESLint line in nestjs-project/CLAUDE.md now matches eslint.config.mjs (no-unsafe-* off in test files only).
  - scripts/smoke-upload.sh (host, curl only): draft -> part URLs in batches -> direct PUT of each part -> complete -> poll status; reports duration, parts, final status and GET / health during the run. Added REFRESH_TOKEN support (renews the token pair every 10 min) because the access token lasts 15 min and a 10 GiB upload can outlast it.
  - MANUAL 10 GiB TEST (dev stack: API `npm run start:dev`, compose video-worker, MinIO, Redis): valid video of 10,733,708,537 bytes (9.997 GiB, rawvideo uyvy422 in a .mov, 582.3 s) -> POST /videos 201 with 160 parts of 64 MiB; upload of all parts 451 s; complete 202; status went processing -> ready on the next poll (worker extracted duration 582.333 s and metadata, thumbnail created); GET / answered 200 in 85/85 probes taken every 5 s during the run. Afterwards GET /videos/:id/stream with Range bytes=5368709120-5368709219 answered 206 with Content-Range .../10733708537 and the thumbnail redirect served a JPEG. Network counters: MinIO received 21.6 GB over the two runs while nestjs-api received about 5 MB in total, i.e. no video bytes passed through the API.
  - The first 10 GiB attempt used a malformed test file (rawvideo yuv420p muxed in .mov: ffprobe itself prints "Invalid pixel format"). The upload part was fine (507 s, 160 parts, complete 202, GET / 97/97 ok) and the worker behaved correctly: PROBE_FAILED was retried 3 times and the video ended in error with failure_reason PROBE_FAILED. Re-generated the file with uyvy422 and re-ran as above. Test videos/objects were deleted from the dev DB and bucket afterwards.
  - Definition of Done, run in the container on the final tree: `npx tsc --noEmit` exit 0; `npm run lint` exit 0; `npm test` (serial) 42 suites / 300 tests passed; `npm run test:e2e` (serial) 6 suites / 92 tests passed (videos-upload 14, videos-delivery 22, video-processing 4, plus the existing auth/app/swagger suites); `npm run build` exit 0.
  - Out of scope, noted for separate tasks: (1) `.env.example` has MAIL_FROM unquoted, which breaks Docker Compose parsing on a fresh clone; (2) `channels.service.ts` still has its own private copy of the pg unique-violation helper that now also exists in src/common/database/pg-errors.ts; (3) request DTO schemas in openapi.json are empty (`properties: {}`) because `npm run openapi:export` runs through ts-node without the Swagger CLI plugin (pre-existing from phase 02; response DTOs are complete because they use explicit @ApiProperty); (4) MinIO upstream is archived and the pinned image is unpatched: dev only, SeaweedFS is the documented fallback; (5) the worker uses `nest start --watch`, which does not see host edits on Windows bind mounts (restart the service).
