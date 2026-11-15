---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-14
scope_description: "Video upload and processing backend: S3-compatible object storage usage, background queue and worker, 10GB direct upload, draft pre-registration, metadata/thumbnail extraction, unique video URL, streaming/download delivery, status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API (video module, storage client, queue producer), plus the new **video worker** entry point and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — Frontend deferred: the video UI is explicitly out of scope for this phase (PRD). No open decision here; the HTTP/storage contracts decided below (TD-04, TD-08) are the surface a future frontend will consume.

_Evidence legend:_ **[doc]** = official library documentation fetched via context7; **[web]** = web source (cited in the TD); **[checked]** = verified on this machine on 2026-11-14; **[inferred]** = my reasoning, not independently verified — to be confirmed in `plan-resolve`.

_Installed state:_ none of the candidate libraries below is installed yet (`nestjs-project/package.json` has no queue, S3 or FFmpeg dependency). Versions are fixed later in `library-refs.md` (plan-resolve), not here.

---

## TD-01: S3-compatible storage server for the local/Compose environment

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project plan and PRD fix the storage *API* as S3 ("S3 or MinIO"); that is not reopened. What must be decided is **which S3-compatible server runs in Docker Compose**. The PRD assumes MinIO, but web sources report that MinIO stopped publishing Community Edition Docker images in Oct 2025 and archived the repository in Feb 2026 **[web]**. On this machine, `docker manifest inspect` could not find any official MinIO tag I tried (`minio/minio:latest`, `quay.io/minio/minio:latest`, two `RELEASE.*` tags) **[checked]** (could be a network quirk, but it matches the news). Application code will use `@aws-sdk/client-s3` regardless, so this choice affects only `compose.yaml` and endpoint config. Production remains AWS S3 (plan).

**Options:**

### Option A: MinIO (as the PRD assumes), via a pinned third-party-published build
- Although no *official* MinIO tag could be pulled, republished builds exist: `bitnamilegacy/minio:2025.7.23`, `cgr.dev/chainguard/minio`, `pgsty/minio`, `coollabsio/minio` all resolve **[checked]**. `bitnamilegacy/minio:2025.7.23` was started locally and answered `200` on `/minio/health/live`, reporting MinIO `2025-07-23` on go1.24.2 **[checked]**.
- **Pros:** exact match with the PRD wording ("MinIO localmente em Docker"); best-known S3 behavior for multipart/presign/CORS; version is **pinned**, so `docker compose up` is reproducible.
- **Cons:** upstream is archived and the `bitnamilegacy` repo receives no updates, so no security patches — acceptable only for local/dev (production is AWS S3 per the plan, so this image never faces the internet); depends on a third-party registry namespace staying available (mitigated: pin the tag, and the S3-only code makes a swap a config change).

### Option B: SeaweedFS (`chrislusf/seaweedfs`)
- Apache-2.0 distributed store with an S3 gateway (`weed mini` / `server`).
- **Pros:** image available **[checked]**; wiki lists multipart operations, presigned URLs, Range GET and per-bucket CORS as supported **[web]**; actively maintained; same code path as AWS S3.
- **Cons:** wiki notes `SignatureDoesNotMatch` risks when the Host seen by the server differs from the signed Host (proxies) **[web]** — directly relevant to TD-02; heavier mental model than MinIO; must be validated with a spike.

### Option C: RustFS (`rustfs/rustfs`)
- Rust S3-compatible store announced as 1.0 GA **[web]**.
- **Pros:** image available **[checked]**; documents multipart + presigned GET/PUT **[web]**; closest "single binary" feel to MinIO.
- **Cons:** its own docs list multipart *listing/part-lookup* edge cases outside the default compatibility gate **[web]** — TD-05 relies on `ListParts`; `latest` tag is for evaluation, production needs a pinned tag **[web]**; youngest project of the three.

**Recommendation:** Option A (MinIO, pinned `bitnamilegacy/minio:2025.7.23`, Compose/dev only), **conditional on the same validation spike** in `plan-resolve`: presigned multipart `UploadPart`, `ListParts`, `CompleteMultipartUpload`, Range `GET`, `ResponseContentDisposition` and bucket CORS. It follows the PRD literally, boots reproducibly **[checked]**, and its multipart/presign behavior is the reference every other S3 server imitates. The security cost of an unpatched image is confined to local development. **Fallback if the spike fails:** Option B (SeaweedFS, longest maintenance record of the remaining options). Option C (RustFS) is rejected for now because its documented gap overlaps our `ListParts` use. Because the code only speaks the S3 API, switching later is a config change. _(Revised during review: the first draft recommended SeaweedFS because no MinIO image could be pulled from the official registries; the owner asked to pursue the PRD wording, and a pinned republished build was then verified.)_

**Decision:** A (MinIO, pinned `bitnamilegacy/minio:2025.7.23`, Compose/dev only). Owner approval: follows the PRD wording; fallback SeaweedFS if the plan-resolve spike fails.

---

## TD-02: Bucket/key layout, access model and endpoint topology

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Defines where video and thumbnail objects live and how clients reach them. There is a structural constraint: a presigned URL's signature is bound to the **Host** it was signed for. Inside Compose the API reaches storage as `http://<storage-service>:<port>` (project rule: service name, never `localhost`), but a **browser/client on the host cannot resolve that name**. A URL signed for the internal host will not work for the client, and one signed for `localhost` breaks the project's Docker-networking rule if used service-to-service. This affects `compose.yaml`, Joi env schema and `.env.example` (cross-component contract).

**Options:**

### Option A: One private bucket, prefix per concern, two endpoints (internal + public)
- Single bucket `videos`; keys `videos/{videoId}/source.{ext}`, `thumbnails/{videoId}/default.jpg`. All access via presigned URLs. Two config values: `S3_ENDPOINT` (service name, used by API/worker) and `S3_PUBLIC_ENDPOINT` (host-reachable, used **only** to sign client-facing URLs).
- **Pros:** one bucket policy/CORS/lifecycle rule set; `videoId`-scoped prefix makes cleanup and idempotent reprocessing trivial; internal traffic keeps the service-name rule.
- **Cons:** two endpoints to configure and keep consistent; public endpoint must be reachable by the client.

### Option B: Separate buckets for videos and thumbnails
- `videos` private, `thumbnails` public-read.
- **Pros:** thumbnails cacheable without signing.
- **Cons:** public bucket policy differs per S3 implementation; Phase 04 visibility (unlisted) makes "public thumbnail" premature; double CORS/lifecycle config.

### Option C: Proxy everything through the API (single internal endpoint)
- Clients never see storage; API streams bytes.
- **Pros:** one endpoint, central auth.
- **Cons:** puts 10GB uploads and all playback bandwidth through the API — the exact failure the PRD forbids; rejected by TD-04/TD-08 reasoning.

**Recommendation:** Option A — it is the only option that satisfies both the Docker-networking rule and client reachability without routing bytes through the API; thumbnails stay private and signed so Phase 04 visibility rules can be layered on later without a bucket migration.

**Decision:** A (one private bucket; internal `S3_ENDPOINT` + public `S3_PUBLIC_ENDPOINT` for client-facing signatures).
**Libraries:** @aws-sdk/client-s3

---

## TD-03: Queue technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue "TBD" — the main open stack decision. Requirements derived from this phase: durable jobs, retry with backoff, a separate worker process, 1 heavy job per video, visible infrastructure in Compose (PRD: "fila, worker e storage reais subindo no Compose"), and real-infra tests. Existing stack: PostgreSQL, NestJS 11.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue; `@Processor`/`WorkerHost` class on the worker, `Queue` injected in the API. Retries via `attempts`/`backoff`; processor errors become `failed` events and are retried per `defaultJobOptions` **[doc]**.
- **Pros:** official Nest integration **[doc]**; the project's own best-practices skill already prescribes `@nestjs/bullmq` for file processing/background jobs (`micro-use-queues`); mature retry, stalled-job recovery, concurrency control; Redis can later serve throttler storage and view-count caching (Phase 05); visible container in Compose.
- **Cons:** one more stateful service; Redis needs persistence (AOF) configured or queued jobs can be lost on restart; **dual-write gap** — DB commit and enqueue are not atomic (mitigated in TD-10).

### Option B: pg-boss (PostgreSQL as the queue)
- Job table in the existing Postgres; `send`/`work` with `retryLimit`, `retryBackoff`, expiry and retention **[doc]**.
- **Pros:** no new infrastructure; enqueue can share the **same transaction** as the status update (removes the dual-write gap); one backup/ops surface.
- **Cons:** no official Nest module (community wrapper or hand-rolled provider); in Compose there is no distinct "queue" service, which may read as missing infrastructure against the PRD's explicit criterion; couples job load to the primary database.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ)
- Broker with exchanges/queues and acks.
- **Pros:** strong delivery semantics; protocol-level routing; independent of Redis/Postgres.
- **Cons:** heaviest to operate; retry/backoff/delayed-retry need manual dead-letter wiring; overkill for a single job type.

### Option D: SQS-compatible (AWS SQS in prod, ElasticMQ locally)
- **Pros:** matches the S3-on-AWS production story.
- **Cons:** local emulator adds a less common component; long-poll worker loop and visibility-timeout tuning are manual; weakest Nest ergonomics of the four.

**Recommendation:** Option A (BullMQ + Redis) — official Nest support and the project's own rule make it the lowest-risk path, Redis is a reusable component for later phases, and it is an unambiguous, visible queue in Compose. Option B is the strongest *technical* rival (atomic enqueue) and loses mainly on integration friction and PRD visibility; the dual-write gap it solves is handled with idempotent jobs plus reconciliation (TD-10). Options C and D add operational weight with no benefit at this scale.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`).
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-04: 10GB upload protocol

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Passing the file through the API is the PRD's "wrong path". The client must send bytes directly to storage while the API only coordinates. Backend side: endpoints that create the draft and sign URLs; client side: the handshake sequence (cross-layer contract). S3 limits **[web: AWS docs]**: multipart allows up to 10,000 parts, 5 MiB–5 GiB per part (last part exempt); a single `PUT` is capped at 5 GiB, so **a 10GB file cannot use one presigned PUT**. 10GB / 10,000 parts would be ≈1MB parts, which violates the 5 MiB minimum, so part size is a policy choice (e.g. 64 MiB ⇒ ≈160 parts for 10 GiB **[inferred arithmetic]**).

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- `POST /videos` → API creates draft row + `CreateMultipartUpload`, returns `videoId`, `uploadId`, part size. Client requests presigned `UploadPart` URLs (in batches), `PUT`s parts straight to storage in parallel/with retry, then calls a completion endpoint (TD-05). Presigning via `@aws-sdk/s3-request-presigner` **[doc]**.
- **Pros:** API never touches bytes; resumable at part granularity; parallel parts; native S3 feature, so it ports from the local server to AWS unchanged.
- **Cons:** client must implement part orchestration and retries; ETag/CORS (`ExposeHeaders: ETag`) must be configured; abandoned uploads leave orphan parts (needs abort/cleanup policy, TD-10).

### Option B: Single presigned PUT
- **Pros:** simplest client.
- **Cons:** capped at 5 GiB per object — cannot reach 10GB. Rejected on a hard limit.

### Option C: tus resumable protocol (tusd or `@tus/server` with S3 store)
- **Pros:** standardized resume semantics and mature client libraries.
- **Cons:** adds another service/protocol layer; S3 store still uses multipart underneath; bytes pass through tus server (extra hop) unless tusd is co-located; more infra for no capability the multipart route lacks.

### Option D: Stream through the API (multipart/form-data to S3 via busboy)
- **Pros:** one endpoint.
- **Cons:** holds an API connection and bandwidth for the full 10GB; this is the PRD's automatic-fail pattern. Rejected.

**Recommendation:** Option A — it is the only option that both exceeds 5 GiB and keeps bytes off the API without adding a new protocol server. Policy defaults for the plan to confirm: fixed part size (≈64 MiB), max declared size 10 GiB enforced at init **and** re-verified at completion by summing part sizes (S3 cannot enforce total size on presigned parts), allowed container types validated by `ffprobe` in the worker (extension/MIME at init is only a hint).

**Decision:** A (S3 multipart upload with presigned part URLs).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
**Revisions:**
- 2026-11-14 — The draft is created at upload start with no title (`title` nullable); the original filename is stored as metadata only. Rationale: Phase 04 owns title editing and the unique URL id (TD-09) must exist before any title (resolves AMB-1).

---

## TD-05: How "upload finished" is detected

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The draft must move to `processing` and a job must be enqueued exactly when the multipart upload is complete.

**Options:**

### Option A: Client calls a completion endpoint
- `POST /videos/:id/upload/complete` with the part list (`PartNumber` + `ETag`). API validates ownership, calls `CompleteMultipartUpload`, verifies size, transitions status, enqueues the job.
- **Pros:** works identically on every S3 implementation; the API controls the transition and the transaction; testable end-to-end with the real storage in Compose.
- **Cons:** relies on the client to call it; if it never does, the draft stays unfinished (covered by cleanup, TD-10).

### Option B: Storage event notifications (bucket events → queue/webhook)
- **Pros:** no client cooperation.
- **Cons:** notification support and configuration differ per S3 implementation (and is exactly what TD-01 is still validating); extra moving part to deliver events to the queue; harder to test deterministically.

**Recommendation:** Option A — explicit and portable; Option B couples the phase to optional, implementation-specific storage features, which is risky given TD-01.

**Decision:** A (client calls a completion endpoint).

---

## TD-06: Video worker topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The architecture diagram has a separate "Video Worker (FFmpeg)" container. It must reach the DB (status updates), storage and the queue, and needs FFmpeg/ffprobe binaries that the API image should not carry.

**Options:**

### Option A: Same NestJS codebase, separate entry point and Compose service
- A second bootstrap (`NestFactory.createApplicationContext`, no HTTP server) loads a worker module with the processor, repositories and storage client; built from a shared image/Dockerfile target with FFmpeg installed; own Compose service.
- **Pros:** reuses entities, repositories, config and the exception conventions (no duplicated model); one build; separate container isolates CPU-heavy work from the API; FFmpeg only in the worker image.
- **Cons:** worker and API deploy from one codebase (coupled releases); needs care so the worker module imports only what it needs (no HTTP stack).

### Option B: Separate package/service with its own `package.json`
- **Pros:** hard isolation; independent deploys.
- **Cons:** duplicates entities/migrations access or needs a shared package (monorepo tooling the project does not have); large overhead for a single job type.

### Option C: Process jobs inside the API process
- **Pros:** no new service.
- **Cons:** FFmpeg competes with request handling; contradicts the architecture diagram and the PRD ("worker ... subindo no Compose").

**Recommendation:** Option A — consistent with the diagram and the PRD, maximum reuse of existing domain code, and keeps FFmpeg out of the API image; Option B's isolation is unnecessary at this size, and Option C is rejected by the PRD.

**Decision:** A (same codebase, separate entry point and Compose service).

---

## TD-07: Media extraction strategy (metadata + thumbnail)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Sources can be up to 10GB. The worker must read duration/metadata and produce one thumbnail without making the phase's cost proportional to file size. No transcoding is in scope (PRD lists only metadata + thumbnail).

**Options:**

### Option A: Read the source over HTTP (presigned internal URL) with `ffprobe`/`ffmpeg`
- Pass a short-lived presigned GET URL to `ffprobe -print_format json` and to `ffmpeg -ss <t> -i <url> -frames:v 1`. FFmpeg's HTTP input uses Range requests and seeks, so MP4s with the index (`moov`) at the end are read via a few ranged requests, not a full download **[inferred — FFmpeg HTTP seeking behavior; must be verified with a real "moov at end" file in plan-resolve]**.
- **Pros:** no 10GB local copy; constant worker disk; fast for the common case.
- **Cons:** behavior depends on container/codec; network errors mid-read need retry; relies on storage Range support (also a TD-01 spike item).

### Option B: Download the object to ephemeral disk, then process
- **Pros:** deterministic; works for any container.
- **Cons:** needs ≥10GB scratch space per concurrent job; minutes of copy time before any work; wasteful for header-only reads.

### Option C: Hybrid — try Option A, fall back to Option B when probing fails
- **Pros:** fast common path, robust fallback.
- **Cons:** two code paths to test.

**Recommendation:** Option C is the safest, but I recommend starting with **Option A** and adding the fallback only if the plan-resolve spike shows real files that fail over HTTP; Option B alone rejected because a 10GB download per job defeats "sem impacto na performance". Spawn `ffprobe`/`ffmpeg` directly with `child_process` (no wrapper library): `fluent-ffmpeg` is a convenience wrapper and I could not confirm it is still maintained **[unverified]**, so it is not recommended.
Thumbnail policy: one JPEG, frame at ~10% of duration (fallback 1 s for short clips), max width 1280, stored at `thumbnails/{videoId}/default.jpg`. The FFmpeg `thumbnail` filter (picks a "representative" frame) is rejected because it decodes many frames, which is expensive over HTTP. Stored metadata: duration (own column), plus container, codec(s), resolution, bitrate, size in a JSONB column.

**Decision:** A (read the source over HTTP with ffprobe/ffmpeg); add the download fallback (Option C) only if the plan-resolve spike shows real files that fail over HTTP.

---

## TD-08: Streaming and download delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** A player (future frontend) needs seekable playback; users also need to download. The architecture diagram already draws **Frontend → Object Storage: "Streams"** directly. Backend decides authorization; the client consumes the URL.

**Options:**

### Option A: API authorizes, then redirects/returns a short-lived presigned GET URL
- `GET /videos/:id/stream` and `GET /videos/:id/download` check access, then respond with `302` (or JSON `{ url }`). Storage serves `Range`/`206` natively; download URL sets `ResponseContentDisposition: attachment` **[inferred — S3 presign parameter; confirm in plan-resolve]**. `Range` is not a signed header, so seeking works.
- **Pros:** playback bandwidth never crosses the API; matches the diagram; seeking is handled by storage; native S3 behavior carries to AWS.
- **Cons:** URL expiry vs long sessions (needs sensible TTL, e.g. 1 h, and re-request on expiry); depends on TD-02's public endpoint; an extra API round trip per playback.

### Option B: API proxies bytes with Range/206
- API pipes from storage and implements `Content-Range`, `Accept-Ranges`, 416 handling.
- **Pros:** full control (per-request auth, view counting, no storage exposure).
- **Cons:** every playing viewer holds an API connection and bandwidth; reimplements what S3 already does; contradicts "sem impacto na performance".

### Option C: CDN/reverse proxy (nginx) in front of storage
- **Pros:** caching, offload.
- **Cons:** extra infrastructure, no Phase 03 need; belongs to a scaling phase.

**Recommendation:** Option A — it reuses storage's native Range support, honors the diagram, and keeps the API a coordinator. Option B's only edge (per-request control) can be added later for view counting without changing the storage layout.

**Decision:** A (API authorizes, then returns a short-lived presigned GET URL).
**Libraries:** @aws-sdk/s3-request-presigner
**Revisions:**
- 2026-11-14 — Phase 03 delivers backend endpoints and contracts only (`nestjs-project/`); the player and the download button (UI) belong to Phase 05. Rationale: the PRD states the video interface is out of scope for this phase (resolves AMB-2).

---

## TD-09: Unique video URL identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** The video needs a public identifier usable in a URL as soon as the draft exists (when there is no title yet; titles are edited in Phase 04).

**Options:**

### Option A: Random short id (e.g. 11 URL-safe chars) in a `UNIQUE` column, separate from the PK
- Generated with a CSPRNG; unique index guarantees no conflict; retry on unique violation.
- **Pros:** compact, non-enumerable, independent of title edits; ~64¹¹ ≈ 7.4·10¹⁹ space makes collisions negligible **[inferred arithmetic]**; PK can stay `uuid` like the other tables.
- **Cons:** one extra column/index; retry loop to code and test.

### Option B: Expose the UUID primary key
- **Pros:** zero extra column; already unique.
- **Cons:** 36-char URLs; couples public URL to internal key.

### Option C: Title-derived slug
- **Pros:** readable URLs.
- **Cons:** no title at draft time; collisions need suffixes; title edits (Phase 04) would change or orphan URLs.

### Option D: Sequential id obfuscated with Hashids
- **Cons:** requires a sequence; obfuscation is reversible if the salt leaks; no advantage over A.

**Recommendation:** Option A — meets "unique without conflict" with a database-enforced guarantee and survives later title edits; B is acceptable but leaks the internal key into URLs.

**Decision:** A (random short id in a UNIQUE column).

---

## TD-10: Status lifecycle, failure and consistency policy

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo; Serviço de processamento em segundo plano (filas)

**Context:** PRD requires `rascunho → processando → pronto/erro` reflected in the DB. Note a naming overlap: Phase 04 has a *"rascunho → publicação"* flow; Phase 03's "rascunho" means "upload not finished yet". The DB write and the enqueue are separate systems (dual-write), and uploads/workers can die midway.

**Options:**

### Option A: One `status` enum `draft → processing → ready | error`, plus `failure_reason`, with idempotent jobs and reconciliation
- `draft` = created at upload start; `processing` after the completion endpoint (TD-05); `ready` when the worker stores metadata+thumbnail; `error` after the final failed attempt (e.g. 3 attempts, exponential backoff). Job id = `videoId` (no duplicate jobs); worker outputs at deterministic keys, so re-running overwrites safely. A reconciliation step re-enqueues videos stuck in `processing` beyond a threshold; a cleanup step aborts multipart uploads and removes `draft` rows idle beyond N days (also configure S3 `AbortIncompleteMultipartUpload` where supported). Phase 04 adds visibility/publication as **separate** fields, not by overloading this enum.
- **Pros:** matches the PRD wording 1:1; single source of truth; failures are visible and recoverable.
- **Cons:** reconciliation/cleanup add scheduled logic to design and test; Phase 04 must resist reusing `draft` for "unpublished".

### Option B: Two orthogonal fields now (`processing_status` + `publication_status`)
- **Pros:** avoids the Phase 03/04 naming clash upfront.
- **Cons:** designs Phase 04's publication model prematurely; diverges from the PRD's stated lifecycle.

### Option C: Status only, no reconciliation/cleanup
- **Pros:** least code.
- **Cons:** a crash between commit and enqueue, or an abandoned multipart upload, leaves rows/parts stuck forever — silently wrong data.

**Recommendation:** Option A — it satisfies the PRD literally and closes the dual-write and orphan-upload holes cheaply; Option B is rejected as premature (Phase 04 scope), Option C as unsafe. **A manual "reprocess" endpoint is intentionally not included** (not in the phase capabilities).

**Decision:** A (status enum + idempotent jobs + reconciliation/cleanup).

---

## TD-11: Access policy for video data in this phase

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The global JWT guard exists (Phase 02) and anonymous users must be able to watch (project plan), but Phase 03 has no publish/visibility concept (Phase 04). Something must define who may create, see status, stream and download.

**Options:**

### Option A: Owner-only for create/status/upload; any caller for `ready` videos' stream/download (marked public endpoints)
- Create/complete/status require JWT and channel ownership; `stream`/`download` are `@Public()`-style for `ready` only; non-owners get `404` for non-`ready` videos.
- **Pros:** honors anonymous playback; hides drafts/errors; simple and testable.
- **Cons:** every `ready` video is world-readable by id until Phase 04 adds unlisted/private; the random id (TD-09) is the only secret.

### Option B: Everything requires JWT (including stream/download)
- **Pros:** strictest.
- **Cons:** breaks the project's "anonymous users can watch freely" principle.

### Option C: Owner-only until Phase 04 publication
- **Pros:** no accidental exposure.
- **Cons:** nobody (including anonymous users) can watch anything in this phase, making the "streaming funcionando" deliverable unverifiable end-to-end.

**Recommendation:** Option A — the only option consistent with both the anonymous-viewing principle and a verifiable streaming deliverable; the exposure risk is explicitly time-boxed to Phase 04, which owns visibility.

**Decision:** A (owner-only write/status; public stream/download for `ready` videos).

---

## TD-12: Integration/e2e test infrastructure with real queue and storage

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The PRD requires real Redis/storage/FFmpeg in tests, not mocks. In the current code, `nestjs-project/package.json` configures Jest's `testRegex` to include `*.integration-spec.ts` in plain `npm test` (parallel workers) while the dedicated `test:integration` script uses `--runInBand`; all integration specs connect to the same `streamtube` database **[code]**. In a local baseline run on 2026-11-14 **[checked]**, parallel execution produced intermittent failures in database-backed suites that passed when run serially. Adding more infrastructure-backed specs will worsen this.

**Options:**

### Option A: Reuse Compose services with per-suite isolation, run integration/e2e serially
- Dedicated test database (`streamtube_test`) or per-suite schema, queue prefix/Redis DB index and bucket prefix per run; integration/e2e executed with `--runInBand`; a tiny test video generated with FFmpeg (`lavfi testsrc`) in the worker image or committed as a few-KB fixture.
- **Pros:** real services as the PRD demands; no new tooling; deterministic.
- **Cons:** slower (serial); isolation must be implemented in test helpers.

### Option B: Testcontainers
- **Pros:** hermetic per run.
- **Cons:** needs Docker socket access inside the `nestjs-api` container (the project's rule runs all tests in that container); slow startup per suite; new dependency.

### Option C: Keep the shared dev database and parallel runs
- **Cons:** measured flaky today **[checked]**; rejected.

**Recommendation:** Option A — real infra with the least new machinery; Option B conflicts with the project's "run everything inside the container" rule; Option C is already demonstrated to fail. Test a 10GB upload logically (part-count/size policy with small parts and a real small file), not by moving 10GB in CI.

**Decision:** A (real Compose services with isolated resources, serial integration/e2e runs).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | S3-compatible storage server in Compose | A — MinIO pinned `bitnamilegacy/minio:2025.7.23` (spike-conditional; fallback SeaweedFS) | A — MinIO (pinned) |
| TD-02 | Backend | Bucket/key layout, access model, endpoints | A — one private bucket, internal + public endpoints | A |
| TD-03 | Backend | Queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-04 | Cross-layer | 10GB upload protocol | A — S3 multipart with presigned part URLs | A |
| TD-05 | Backend | Upload-complete detection | A — client completion endpoint | A |
| TD-06 | Backend | Worker topology | A — same codebase, separate entry point/container | A |
| TD-07 | Backend | Metadata + thumbnail extraction | A (HTTP read), with fallback only if the spike requires it | A |
| TD-08 | Cross-layer | Streaming and download delivery | A — authorize, then presigned GET (Range by storage) | A |
| TD-09 | Backend | Unique video URL identifier | A — random short id, UNIQUE column | A |
| TD-10 | Backend | Status lifecycle, failure, consistency | A — enum + idempotent jobs + reconciliation/cleanup | A |
| TD-11 | Backend | Access policy in this phase | A — owner-only write/status; public `ready` stream/download | A |
| TD-12 | Repo-wide | Real-infra test strategy | A — Compose services, isolated resources, serial runs | A |

## Sources

- AWS SDK for JavaScript v3 (`@aws-sdk/s3-request-presigner`, presigned `GetObject`/`PutObject`) — via context7.
- `@nestjs/bullmq` (processors, retries, worker options) — via context7 (`/nestjs/bull`).
- pg-boss (`send`, `retryLimit`, `retryBackoff`, `work`) — via context7 (`/timgit/pg-boss`).
- [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/us_en/AmazonS3/latest/userguide/qfacts.html) — 10,000 parts, 5 MiB–5 GiB part size.
- [MinIO community edition archived and unmaintained](https://github.com/michelangelo-ai/michelangelo/issues/672); [MinIO Is Done With Open Source](https://daily.dev/posts/minio-is-done-with-open-source-what-are-your-options--wzuzouq5b); [MinIO Is Dead, Long Live MinIO (fork)](https://silo.pgsty.com/blog/post/minio-resurrect/) — secondary/vendor sources; verify before relying on them.
- [SeaweedFS Amazon S3 API](https://github.com/chrislusf/seaweedfs/wiki/Amazon-S3-API) — multipart, presigned, Range, CORS.
- [RustFS S3 protocol docs](https://docs.rustfs.com/administration/protocols/s3) and [RustFS 1.0 GA announcement](https://linuxiac.com/rustfs-1-0-s3-compatible-object-storage-reaches-ga/).
- Local checks on 2026-11-14: Docker image availability (`docker manifest inspect`) and a baseline test run, repeatable with the commands in `nestjs-project/CLAUDE.md`.
- Code evidence: `nestjs-project/package.json` (Jest `testRegex`, `test:integration` script, dependency list), `docs/diagrams/software-arch.mermaid`, `.claude/skills/nestjs-best-practices/rules/micro-use-queues.md`.
