# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl http://localhost:9000/minio/health/live` — expect HTTP `200`
- **Video worker:** `docker compose exec video-worker ffmpeg -version` — expect version 7 or higher; its logs (`docker compose logs video-worker`) show `Video worker is running` once the first compilation ends

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP catcher, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, API on `9000` (image `bitnamilegacy/minio`; upstream MinIO is archived, so **development only**). The bucket `S3_BUCKET` is created automatically
- `redis` — BullMQ broker with AOF persistence (`--appendonly yes`), internal port `6379`
- `video-worker` — the FFmpeg video worker (same codebase, entry point `src/worker/worker.main.ts`), started with `npm run start:worker`

`nestjs-api` and `video-worker` both ship FFmpeg/ffprobe **7.1** (static binaries copied from `mwader/static-ffmpeg:7.1` in `Dockerfile.dev` and `Dockerfile.worker`; the Debian package is 5.x and is not used). The API never runs FFmpeg at runtime: it is in the API image only so the e2e suite can run the worker in-process.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker                     # Video worker (the `video-worker` service runs this)

npm test                                 # Unit + integration tests (serial: --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial: --runInBand)

npm run openapi:export                   # Regenerate openapi.json (a test fails if it is stale)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Isolated test resources.** Tests never touch development data. `test/set-test-env.ts` (loaded after `dotenv/config`) points every Jest process at the database `streamtube_test`, the bucket `streamtube-test` and the queue prefix `streamtube-test`, forces `VIDEO_PART_SIZE_BYTES=5242880` and makes `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` (inside the Docker network `localhost:9000` does not reach MinIO). `test/jest-global-setup.ts` recreates the `public` schema of `streamtube_test` and applies the migrations before every Jest run. Integration and e2e tests use the **real** Compose services (`db`, `minio`, `redis`), so `docker compose up -d` must be running; clean what you create with `cleanAllTables` (`src/test/create-test-data-source.ts`), `cleanStorage` (`src/test/clean-storage.ts`) and `cleanQueues` (`src/test/clean-queue.ts`).

**Always wrap long Jest runs in `timeout`** (e.g. `timeout 900 npm test`): a module that cannot connect makes TypeORM retry forever and the run would hang instead of failing. Never add `Prefix` to `ListMultipartUploads` against MinIO: it returns an empty list, so filter by key on the client (as `src/test/clean-storage.ts` does).

**FFmpeg-dependent tests.** `test/video-processing.e2e-spec.ts` boots the API **and** the real `WorkerModule` in the same process and uploads the fixtures in `test/fixtures/` (see its `README.md` for how they were generated). It needs `ffmpeg`/`ffprobe` on the PATH, which the `nestjs-api` image provides. Unit and integration tests mock the FFmpeg boundary (`MediaProbeService`).

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `test:watch`, and any other persistent process.

The `video-worker` service runs `nest start --watch`; on Windows bind mounts it does not see edits made on the host, so run `docker compose restart video-worker` after changing worker code. Its first compilation takes several minutes.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `setupFiles` also lists `test/set-test-env.ts` after `dotenv/config`, and `globalSetup` points to `test/jest-global-setup.ts` (isolated test resources, see "Test execution").
- `testTimeout: 60000` — the default 5 s makes the `beforeAll` of the slow-booting e2e suites fail.
- `transform` / `transformIgnorePatterns` route `@nestjs/bullmq` and `@nestjs/bull-shared` (ESM-only packages that Jest cannot load) through `test/esm-to-cjs.transformer.js`. Node itself loads them natively, so the application needs no such workaround.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

### Storage, queue and video variables

Defined and validated (Joi) in `src/config/env.validation.ts`, read by `src/config/storage.config.ts`, `queue.config.ts` and `videos.config.ts`, and listed in `.env.example`:

| Variable | Meaning |
|---|---|
| `S3_ENDPOINT` | Internal endpoint = the Compose service name (`http://minio:9000`), used by the API and the worker |
| `S3_PUBLIC_ENDPOINT` | Endpoint baked into presigned URLs handed to clients |
| `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | Credentials and the single private bucket |
| `S3_PRESIGN_EXPIRES_SECONDS` | Lifetime of presigned URLs (default `3600`) |
| `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX` | BullMQ connection (`redis`, `6379`) and the key prefix |
| `VIDEO_PART_SIZE_BYTES` | Multipart part size (default 64 MiB, minimum 5 MiB) |
| `VIDEO_WORKER_CONCURRENCY`, `VIDEO_SWEEP_INTERVAL_MS`, `VIDEO_PROCESSING_STUCK_MINUTES`, `VIDEO_DRAFT_TTL_DAYS` | Worker concurrency and the maintenance sweep |

**The only permitted `localhost`:** `S3_PUBLIC_ENDPOINT=http://localhost:9000`. A presigned URL is consumed by the client (browser, `curl` on the host) **outside** the Docker network and its signature binds the `Host` header, so it must name an address the client can reach. Every other host (`db`, `redis`, `minio`, `S3_ENDPOINT`) stays a Compose service name.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- `DatabaseModule` (`src/database/database.module.ts`) owns the single TypeORM connection factory, shared by `AppModule` and the worker's `WorkerModule`. Because the connection uses `autoLoadEntities`, **every entity in a relation chain must be registered with `forFeature`** in the module that boots (`Video` → `Channel` → `User`); otherwise TypeORM fails with "Entity metadata … was not found"

## Videos: upload, processing and delivery

Plan, decisions and per-step progress: `docs/phases/phase-03-videos/` and `docs/decisions/technical-decisions-phase-03-videos.md`. Video **bytes never pass through the API**: the client uploads straight to S3-compatible storage and downloads/streams straight from it.

| Module | Role |
|---|---|
| `src/videos/` | `VideosController` (7 routes), `VideoUploadsService` (draft → part URLs → complete), `VideoDeliveryService` (stream/download/thumbnail redirects), `VideosService` (persistence, ownership, status transitions), `VideoMaintenanceService` (sweep routines), `Video` entity + `CreateVideos` migration |
| `src/storage/` | `StorageService`: two S3 clients (internal for API/worker, public only to sign client URLs), multipart, presigned URLs, `ensureBucket` on boot |
| `src/queue/` | BullMQ queues `video-processing` and `video-maintenance`; `VideoQueueService` enqueues with `jobId = videoId` (idempotent) |
| `src/worker/` | Separate application (`worker.main.ts` + `WorkerModule`, no HTTP server): `VideoProcessingProcessor`, `MediaProbeService` (ffprobe/ffmpeg via `spawn` with argument arrays), `VideoMaintenanceProcessor` and `VideoMaintenanceScheduler` |

**Lifecycle:** `draft → processing → ready | error` (`ready` and `error` are final). `POST /videos` creates the draft and the multipart upload; `part-urls` signs part URLs; `complete` re-checks the parts and sizes against storage (`ListParts`), moves the video to `processing` and **only after that commit** enqueues the job. The worker reads the source through an internal presigned URL, extracts duration/metadata with `ffprobe`, renders a JPEG thumbnail, and finalises with conditional updates (`WHERE status = 'processing'`), so redelivered jobs change nothing. A file that is not a video ends as `error` with `failure_reason = NOT_A_VIDEO` without retries. The maintenance sweep (a BullMQ job scheduler, every `VIDEO_SWEEP_INTERVAL_MS`) re-enqueues videos stuck in `processing` and aborts + deletes abandoned drafts.

**Routes** (`@Controller('videos')`; the exported contract is `openapi.json`): `POST /videos`, `POST /videos/:publicId/upload/part-urls`, `POST /videos/:publicId/upload/complete`, `GET /videos/:publicId` (owner only), and the public `GET /videos/:publicId/stream`, `/download`, `/thumbnail` (302 redirect to a presigned URL, `Cache-Control: no-store`, only for `ready` videos). `publicId` is an 11-character random id; the internal uuid is never exposed. Anyone but the owner, and any non-`ready` video on public routes, gets `404 VIDEO_NOT_FOUND`.

**Rate limits:** the global `ThrottlerGuard` allows 10 requests/minute, which would break a 10 GiB upload (~160 `part-urls` calls), so `part-urls` has an explicit `@Throttle` of 300/min, status 60/min and stream/download/thumbnail 120/min.

**Manual end-to-end check:** `scripts/smoke-upload.sh <video file>` (host, `curl` only) runs the whole flow against a running API and reports duration, part count, final status and whether `GET /` kept answering `200`. The header of the script explains how to obtain `ACCESS_TOKEN`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings in `src`. In test files only (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`, `src/test/**`, `test/**`) the `no-unsafe-*` rules and `unbound-method` are off, because Jest mocks and supertest bodies are `any` by nature (`eslint.config.mjs`)

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
