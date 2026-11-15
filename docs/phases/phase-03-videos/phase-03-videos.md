---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-14T21:15:25-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-14T21:15:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-14T20:23:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-14T16:35:22-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend of video upload and processing in `nestjs-project/`: S3-compatible object storage, a Redis-backed queue and a separate FFmpeg worker (all running in Docker Compose), direct-to-storage multipart upload of files up to 10 GiB with an automatic draft pre-registration, automatic duration/metadata extraction and thumbnail generation, a unique non-conflicting public id per video, and streaming and download delivery — with the `draft → processing → ready | error` lifecycle persisted in PostgreSQL. The video user interface (player, download button) is out of scope and belongs to Phase 05.

---

## Step Implementations

### SI-03.1 — Instalar dependências, configurar namespaces e subir MinIO e Redis no Compose

**Description:** Instala as bibliotecas de storage e fila, cria os namespaces de configuração `storage`, `queue` e `videos` com validação Joi e sobe MinIO e Redis no Docker Compose — a base de infraestrutura de toda a fase.

**Technical actions:**

1. Instalar em `nestjs-project` (`docker compose exec nestjs-api npm install ...`): `@aws-sdk/client-s3@^3.1169.0`, `@aws-sdk/s3-request-presigner@^3.1169.0`, `bullmq@^6.7.6` e `@nestjs/bullmq@^12.0.2` — versões fixadas em `library-refs.md` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (host interno, nome do serviço `minio`), `S3_PUBLIC_ENDPOINT` (host alcançável pelo cliente), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` e `S3_PRESIGN_EXPIRES_SECONDS` (default `3600`) (per `phase-03-videos/TD-02`)
3. Criar `src/config/queue.config.ts` (`REDIS_HOST` default `redis`, `REDIS_PORT` default `6379`, `QUEUE_PREFIX` default `streamtube`) e `src/config/videos.config.ts` (`VIDEO_PART_SIZE_BYTES` default `67108864` com mínimo `5242880`, `VIDEO_WORKER_CONCURRENCY` default `1`, `VIDEO_SWEEP_INTERVAL_MS` default `300000`, `VIDEO_PROCESSING_STUCK_MINUTES` default `30`, `VIDEO_DRAFT_TTL_DAYS` default `2`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
4. Atualizar `src/config/env.validation.ts` (Joi: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` e `S3_BUCKET` obrigatórias; demais com default), registrar os três namespaces no `load` do `ConfigModule` em `AppModule` e acrescentar todas as chaves ao `.env.example` — com `S3_ENDPOINT=http://minio:9000` e `S3_PUBLIC_ENDPOINT=http://localhost:9000`, que é o único uso permitido de `localhost`: uma URL assinada consumida pelo cliente fora da rede Docker (per `phase-03-videos/TD-02`)
5. Adicionar ao `compose.yaml` os serviços `minio` (`bitnamilegacy/minio:2025.7.23`, API na porta `9000`, volume nomeado, healthcheck em `/minio/health/live`) e `redis` (`redis:7-alpine` com `--appendonly yes`, volume nomeado, healthcheck `redis-cli ping`), e fazer `nestjs-api` depender dos dois saudáveis (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: chaves obrigatórias ausentes falham no bootstrap; defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none _(pré-requisito externo: o ramo de baseline de lint e suíte mesclado na `dev` — ver Dependency Map)_

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy` em `docker compose ps`
- `docker compose exec redis redis-cli CONFIG GET appendonly` retorna `yes`
- `GET http://localhost:9000/minio/health/live` (do host) retorna `200`
- Iniciar a aplicação sem `S3_ENDPOINT` falha no bootstrap com erro de validação do Joi
- `docker compose config` aceita o `.env` criado a partir do `.env.example` sem erro de parsing
- `npx tsc --noEmit` continua com código de saída `0` após a instalação das dependências

---

### SI-03.2 — Isolar a infraestrutura de testes e gerar fixtures de vídeo

**Description:** Faz os testes de integração e e2e rodarem contra recursos isolados (banco `streamtube_test`, prefixos próprios de fila e bucket) e cria fixtures de vídeo minúsculas, para que a suíte com infraestrutura real seja determinística.

**Technical actions:**

1. Criar `test/jest-global-setup.ts` — cria o banco `streamtube_test` se não existir (conexão administrativa no banco `streamtube`) e aplica as migrations nele; referenciá-lo em `globalSetup` no bloco `jest` do `package.json` e em `test/jest-e2e.json` (per `phase-03-videos/TD-12`)
2. Criar `test/set-test-env.ts`, listado em `setupFiles` depois de `dotenv/config` nos dois configs de Jest, sobrescrevendo `DB_NAME` e `DB_DATABASE` (`streamtube_test`), `S3_BUCKET` (`streamtube-test`), `QUEUE_PREFIX` (`streamtube-test`), `VIDEO_PART_SIZE_BYTES` (`5242880`) e `S3_PUBLIC_ENDPOINT` igual a `S3_ENDPOINT` — os testes rodam dentro da rede Docker, onde `localhost:9000` não alcança o MinIO (per `phase-03-videos/TD-12`)
3. Alterar `src/test/create-test-data-source.ts` para ler o banco de `DB_NAME` (hoje usa `DB_DATABASE`, divergente do restante da configuração)
4. Gerar `test/fixtures/sample.mp4`, `sample.webm` e `sample.mov` (≈2 s, 320x240, até 50 KB cada) com FFmpeg 7 (`jrottenberg/ffmpeg:7-alpine`, fonte `testsrc`) e commitar os arquivos junto de `test/fixtures/README.md` com o comando exato de geração (per `phase-03-videos/TD-12`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| isolamento do banco de teste | Integration: o processo de teste usa `streamtube_test` e não altera o banco `streamtube` | `src/test/test-isolation.integration-spec.ts` |

**Dependencies:** SI-03.1 — as chaves `S3_*`, `QUEUE_PREFIX` e `VIDEO_PART_SIZE_BYTES` precisam existir antes de serem sobrescritas

**Acceptance criteria:**

- Após a primeira execução de `npm test`, o banco `streamtube_test` existe com as tabelas migradas (`SELECT 1 FROM pg_database WHERE datname = 'streamtube_test'` retorna uma linha)
- Executar a suíte de integração não altera nenhuma linha das tabelas do banco `streamtube` de desenvolvimento
- Dentro do container de teste, `process.env.S3_PUBLIC_ENDPOINT` é igual a `process.env.S3_ENDPOINT`
- Cada arquivo em `test/fixtures/` tem no máximo 50 KB e o `ffprobe` (imagem FFmpeg) reporta um stream de vídeo válido

---

### SI-03.3 — Criar a entidade Video, a migration CreateVideos e as exceções de domínio

**Description:** Modela a tabela `videos` ligada ao canal, com o ciclo de status e as chaves de storage, e adiciona as exceções de domínio do Error Catalog.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `Video` mapeando a tabela do Data Model (`@Entity('videos')`, colunas `snake_case`, enum `VideoStatus` em `src/videos/video-status.enum.ts` com `draft`, `processing`, `ready`, `error`, e transformers numéricos para `size_bytes` e `duration_seconds`) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-02`, `phase-03-videos/TD-07`)
2. Alterar `src/channels/entities/channel.entity.ts` — lado inverso `@OneToMany(() => Video, (video) => video.channel) videos`, sem mudança de schema (regra de entidades: as duas pontas da relação)
3. Gerar a migration `CreateVideos` com `npm run migration:generate` (tipo `videos_status_enum`, tabela, FK para `channels`, unique em `public_id`, índices em `channel_id` e `status`) e conferir que o `down` remove a tabela **e** o tipo enum
4. Adicionar a `src/common/exceptions/domain.exception.ts` as exceções `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoInvalidStateException` (`VIDEO_INVALID_STATE`, 409), `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 413), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400), `UploadPartsMismatchException` (`UPLOAD_PARTS_MISMATCH`, 422), `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422) e `StorageUnavailableException` (`STORAGE_UNAVAILABLE`, 503), exatamente como no Error Catalog
5. Atualizar `cleanAllTables` em `src/test/create-test-data-source.ts` para apagar `videos` antes de `channels` (respeitar a FK)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique de `public_id`, default `draft`, FK de `channel_id`, `title` nulo, enum inválido rejeitado | `src/videos/entities/video.entity.integration-spec.ts` |
| migration `CreateVideos` | Integration: aplicar e reverter remove tabela e tipo enum | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.2 — os testes de integração precisam do banco de teste isolado

**Acceptance criteria:**

- Após `npm run migration:run`, a tabela `videos` existe com as colunas e os índices do Data Model
- Inserir dois vídeos com o mesmo `public_id` falha por violação de unicidade
- Inserir um vídeo sem informar `status` grava `draft`, e `title` nulo é aceito
- Inserir um vídeo com `channel_id` inexistente falha por violação de chave estrangeira
- Um valor fora do enum em `status` é rejeitado pelo banco
- `npm run migration:revert` remove a tabela `videos` e o tipo `videos_status_enum` (`SELECT 1 FROM pg_type WHERE typname = 'videos_status_enum'` não retorna linhas)

---

### SI-03.4 — Criar o StorageModule e o StorageService (S3)

**Description:** Encapsula o acesso ao storage S3 em um serviço com dois clientes — interno (API e worker) e público (somente para assinar URLs do cliente) — cobrindo o ciclo multipart, a leitura por Range e o download.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.constants.ts` — providers `S3_INTERNAL_CLIENT` (endpoint `S3_ENDPOINT`, usado por API e worker) e `S3_PUBLIC_CLIENT` (endpoint `S3_PUBLIC_ENDPOINT`, usado **somente** para assinar URLs entregues ao cliente), ambos `S3Client` com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-02`; ver "Gotchas" em `library-refs.md`)
2. Criar `src/storage/storage.service.ts` — `StorageService` com `ensureBucket()` (no `onModuleInit`, idempotente), `createMultipartUpload`, `presignUploadPart` (cliente público), `listParts`, `completeMultipartUpload`, `abortMultipartUpload` (ignora `NoSuchUpload`), `headObject`, `putObject`, `presignGetObject` (cliente público; aceita `downloadFilename` → `ResponseContentDisposition`) e `presignInternalGetObject` (cliente interno, usado pelo worker) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-07`)
3. Converter falhas das operações multipart em `StorageUnavailableException`, sem vazar detalhes do SDK ao cliente
4. Criar o helper de teste `src/test/clean-storage.ts` — remove os objetos do bucket de teste por prefixo

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): ciclo multipart com `PUT` direto nas URLs assinadas, `ListParts`, `Complete`, `Head`; `GET` com `Range` → 206; `Content-Disposition`; `abort`; `ensureBucket` idempotente | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Unit: a URL de parte usa o host de `S3_PUBLIC_ENDPOINT`, a leitura interna usa `S3_ENDPOINT`; falha do SDK vira `StorageUnavailableException` | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação do módulo | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — config `storage` e MinIO; SI-03.3 — `StorageUnavailableException`

**Acceptance criteria:**

- `ensureBucket` cria o bucket configurado quando ausente e não faz nada quando ele existe
- Um objeto enviado em 3 partes pelas URLs assinadas e concluído fica disponível com a soma exata dos tamanhos das partes
- A URL de `presignGetObject`, chamada com `Range: bytes=0-9`, responde `206` com `Content-Range`
- A URL de download assinada responde com `Content-Disposition: attachment; filename="..."`
- `abortMultipartUpload` de um upload inexistente não lança erro
- A URL de parte assinada tem o host de `S3_PUBLIC_ENDPOINT`
- Quando o storage está indisponível, as operações multipart lançam `StorageUnavailableException`

---

### SI-03.5 — Criar o QueueModule e o produtor de jobs de vídeo

**Description:** Registra o BullMQ com as filas `video-processing` e `video-maintenance` e cria o serviço que enfileira o processamento de forma idempotente.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_MAINTENANCE_QUEUE = 'video-maintenance'`, nomes de job `process-video` e `sweep` e `VIDEO_MAINTENANCE_SCHEDULER_ID = 'video-maintenance-sweep'`
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `queue.config` (`connection` com host e porta, `prefix` de `QUEUE_PREFIX`) e `BullModule.registerQueueAsync` para as duas filas; a fila `video-processing` com `defaultJobOptions` `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } }` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-10`)
3. Criar `src/queue/video-queue.service.ts` — `VideoQueueService.enqueueProcessing(videoId)` chamando `queue.add('process-video', { videoId }, { jobId: videoId })`, idempotente por `jobId` (per `phase-03-videos/TD-10`)
4. Criar o helper de teste `src/test/clean-queue.ts` — esvazia (`obliterate`) as filas com o prefixo de teste

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoQueueService` | Integration (Redis real): job com `jobId = videoId` e payload `{ videoId }`; segundo enqueue do mesmo id não duplica; opções de retry herdadas | `src/queue/video-queue.service.integration-spec.ts` |
| `QueueModule` | Unit: compilação do módulo | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 — config `queue` e Redis; SI-03.2 — prefixo de fila de teste

**Acceptance criteria:**

- `enqueueProcessing(id)` cria exatamente um job na fila `video-processing` com `jobId` igual a `id` e dados `{ videoId: id }`
- Chamar `enqueueProcessing` de novo com o mesmo `id`, com o job ainda existente, não cria um segundo job
- O job criado tem `attempts` igual a 3 e backoff exponencial de 5000 ms
- Os jobs ficam no Redis sob o prefixo configurado em `QUEUE_PREFIX`
- Jobs enfileirados sobrevivem a `docker compose restart redis`

---

### SI-03.6 — Implementar o fluxo de upload: rascunho, URLs de partes e conclusão

**Description:** Entrega `POST /videos`, `POST /videos/{publicId}/upload/part-urls` e `POST /videos/{publicId}/upload/complete`: pré-cadastra o rascunho, deixa o cliente enviar as partes direto ao storage e, ao concluir, move o vídeo para `processing` e enfileira o job.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (importa `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` e `QueueModule`; exporta `VideosService`), registrá-lo em `AppModule`, e criar `src/videos/videos.service.ts` com `createDraft` (gera `public_id` de 11 caracteres via `src/videos/public-id.util.ts` — `crypto.randomBytes`, alfabeto `A-Za-z0-9_-` — com retry em violação de unicidade `23505`, até 5 tentativas), `findOwnedByPublicId(publicId, userId)` (por `channel.user_id`) e `markProcessing` (transação: `draft → processing`, `processing_started_at = now()`, `upload_id = null`) (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`)
2. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` — a propriedade do canal continua no módulo de canais
3. Criar `src/videos/video-uploads.service.ts` — `VideoUploadsService`: `startUpload` (tamanho acima de 10 GiB → `VideoTooLargeException`; monta `source_key` `videos/{id}/source.{ext}`; `createMultipartUpload`; persiste o rascunho e aborta o multipart se o insert falhar), `getPartUrls` (estado `draft`; `InvalidPartNumberException`) e `completeUpload` (`ListParts` deve casar com as partes enviadas → `UploadPartsMismatchException`; soma igual a `size_bytes` → `UploadSizeMismatchException`; soma acima de 10 GiB → `VideoTooLargeException`; `completeMultipartUpload`; `markProcessing`; **depois do commit**, `VideoQueueService.enqueueProcessing`, cuja falha é apenas registrada em log porque a varredura de SI-03.9 recupera) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
4. Criar os DTOs `src/videos/dto/create-video.dto.ts`, `part-urls.dto.ts` e `complete-upload.dto.ts` com as regras de "Validation Rules — videos", e os DTOs de resposta
5. Criar `src/videos/videos.controller.ts` — `@Controller('videos')` e `@ApiTags('videos')` com as três rotas (`201`, `200`, `202`), `@ApiBearerAuth('access-token')`, `@ApiOperation` e um `@ApiResponse` por status (erros com `ApiErrorEnvelope`), `@CurrentUser()`, e `@Throttle({ default: { limit: 300, ttl: 60000 } })` em `part-urls`, porque o `ThrottlerGuard` global herdado (10 por minuto) devolveria `429` no meio de um upload de 10 GiB

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `public-id.util` | Unit: 11 caracteres do alfabeto, sem repetição em amostra grande | `src/videos/public-id.util.spec.ts` |
| `VideoUploadsService` | Unit: ramos de tamanho, estado, `partNumber`, divergência de partes e de tamanho, falha do enqueue não falha o `complete` (repositório e storage simulados) | `src/videos/video-uploads.service.spec.ts` |
| `VideosService` | Integration: rascunho com `public_id` único e retry, busca por dono, transição `draft → processing` atômica | `src/videos/videos.service.integration-spec.ts` |
| `VideoUploadsService` | Integration (DB, MinIO e Redis reais): `startUpload`, envio das partes e `completeUpload` deixam a linha `processing` e o job enfileirado | `src/videos/video-uploads.service.integration-spec.ts` |
| `VideosController` | E2E: contratos de `POST /videos`, `part-urls` e `complete` com upload direto real no MinIO | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.3 — entidade e exceções; SI-03.4 — storage; SI-03.5 — fila

**Acceptance criteria:**

- `POST /videos` com token e corpo válido retorna `201` com `publicId` de 11 caracteres, `status: "draft"`, `partSizeBytes` e `partCount`, e a linha criada pertence ao canal do usuário com `title` nulo
- `POST /videos` sem token retorna `401`, e com `contentType` fora da lista retorna `400`
- `POST /videos` com `sizeBytes: 10737418241` retorna `413` com `error: "VIDEO_TOO_LARGE"` e não cria linha
- `POST /videos/{publicId}/upload/part-urls` do dono retorna `200` com as URLs, e um `PUT` de cada parte direto em sua URL retorna `200` com `ETag`
- `part-urls` de outro usuário retorna `404` com `VIDEO_NOT_FOUND`, e com `partNumbers` acima de `partCount` retorna `400` com `INVALID_PART_NUMBER`
- Mais de 10 chamadas por minuto a `part-urls` do mesmo cliente não retornam `429`
- `POST /videos/{publicId}/upload/complete` com as partes corretas retorna `202` com `status: "processing"`; a linha fica `processing` com `processing_started_at` preenchido e existe um job `process-video` do vídeo
- Um segundo `complete` do mesmo vídeo retorna `409` com `VIDEO_INVALID_STATE`
- `complete` com `etag` incorreto retorna `422` com `UPLOAD_PARTS_MISMATCH`, e com soma de bytes diferente da declarada retorna `422` com `UPLOAD_SIZE_MISMATCH`

---

### SI-03.7 — Implementar o worker de vídeo: metadados, thumbnail e ciclo de status

**Description:** Cria o worker FFmpeg como aplicação Nest separada (entry point e serviço Compose próprios) que consome `process-video`, extrai duração e metadados com `ffprobe`, gera o thumbnail e leva o vídeo a `ready` ou `error`.

**Technical actions:**

1. Criar `Dockerfile.worker` (`node:25.6.0-slim` com `apt-get install ffmpeg`), adicionar o serviço `video-worker` ao `compose.yaml` (build com esse Dockerfile, mesmo bind mount do projeto, `command: npm run start:worker`, dependente de `db`, `redis` e `minio` saudáveis) e o script `start:worker` (`nest start --watch --entryFile worker/worker.main`) em `package.json` (per `phase-03-videos/TD-06`)
2. Criar `src/database/database.module.ts` (extrai o `TypeOrmModule.forRootAsync` do `AppModule`, mantendo uma única fábrica de conexão) e usá-lo em `AppModule` e em `src/worker/worker.module.ts`; criar `src/worker/worker.main.ts` com `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks()`, sem servidor HTTP (per `phase-03-videos/TD-06`)
3. Criar `src/worker/media-probe.service.ts` — `MediaProbeService.probe(url)` (`ffprobe -v error -print_format json -show_format -show_streams` via `child_process.spawn` com array de argumentos e timeout) devolvendo `durationSeconds` e `metadata`, e `extractThumbnail(url, seconds)` (`ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 3`, saída JPEG); o instante do thumbnail é 10% da duração (para duração menor que 10 s, `min(1, duração/2)`) (per `phase-03-videos/TD-07`)
4. Criar `src/worker/video-processing.processor.ts` — `VideoProcessingProcessor extends WorkerHost` (`@Processor(VIDEO_PROCESSING_QUEUE, { concurrency })`): encerra sem erro se o vídeo não está `processing`; lê o objeto por URL pré-assinada interna (`presignInternalGetObject`); sem stream de vídeo lança `UnrecoverableError('NOT_A_VIDEO')`; grava o thumbnail em `thumbnails/{id}/default.jpg` e conclui com update condicional para `ready`, `duration_seconds`, `metadata` e `thumbnail_key`; `@OnWorkerEvent('failed')` marca `error` e `failure_reason` quando as tentativas se esgotam ou o erro é irrecuperável (per `phase-03-videos/TD-10`)
5. Adicionar a `VideosService` os métodos `markReady` e `markError`, updates condicionais em `status = 'processing'` e idempotentes, usados pelo processor

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Unit: interpretação do JSON do `ffprobe` (metadados e `NOT_A_VIDEO` sem stream de vídeo), instante do thumbnail, argumentos sem shell | `src/worker/media-probe.service.spec.ts` |
| `VideoProcessingProcessor` | Integration (DB e MinIO reais; `MediaProbeService` simulado por ser a fronteira do FFmpeg): `processing → ready`, `NOT_A_VIDEO` → `error` sem retry, entrega duplicada sem efeito | `src/worker/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo | `src/worker/worker.module.spec.ts` |
| pipeline do worker | E2E (worker real no Compose): upload real de `sample.mp4`, `sample.webm` e `sample.mov` pela API e pelo MinIO até `ready`, com duração, metadados e thumbnail; arquivo que não é vídeo termina em `error` | `test/video-processing.e2e-spec.ts` |

**Dependencies:** SI-03.6 — o fluxo de upload alimenta o worker e o e2e; SI-03.5 — fila; SI-03.4 — storage; SI-03.2 — fixtures de vídeo

**Acceptance criteria:**

- Com `docker compose up -d`, o serviço `video-worker` fica em execução e `docker compose exec video-worker ffmpeg -version` mostra a versão 7 ou superior
- Depois de completar o upload de `sample.mp4`, o vídeo chega a `ready` em até 60 s com `duration_seconds` próximo de 2 e `metadata` contendo `container`, `videoCodec`, `width` e `height`
- O objeto `thumbnails/{id}/default.jpg` existe no storage e é um JPEG válido (começa com os bytes `FF D8 FF`)
- `sample.webm` e `sample.mov` também chegam a `ready`
- Um arquivo de texto enviado como `video/mp4` leva o vídeo a `error` com `failure_reason` igual a `NOT_A_VIDEO`, sem consumir as 3 tentativas
- Reentregar o job de um vídeo já `ready` não altera a linha (`updated_at` inalterado)
- Se o vídeo não está mais em `processing` quando o job roda, o processor encerra sem erro e sem alterar a linha

---

### SI-03.8 — Implementar a entrega: status do vídeo, streaming, download e thumbnail

**Description:** Entrega `GET /videos/{publicId}` (dono) e os endpoints públicos `stream`, `download` e `thumbnail`, que autorizam e redirecionam para URLs pré-assinadas — o storage atende `Range` e nenhum byte de vídeo passa pela API.

**Technical actions:**

1. Criar `src/videos/video-delivery.service.ts` — `VideoDeliveryService` com `getStreamUrl`, `getDownloadUrl` (filename sem aspas e sem caracteres de controle, com fallback `{publicId}.{ext}`) e `getThumbnailUrl`; só vídeos `ready` (e com thumbnail, no caso do thumbnail), caso contrário `VideoNotFoundException` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
2. Adicionar `VideosService.getOwnedStatus(publicId, userId)` e o DTO `VideoStatusResponseDto` com os campos do contrato de `GET /videos/{publicId}`
3. Adicionar ao `VideosController` as rotas `GET /videos/:publicId` (dono, `@ApiBearerAuth('access-token')`) e `GET /videos/:publicId/stream`, `/download` e `/thumbnail` com `@Public()`, respondendo `302` com `@Redirect()` dinâmico e `Cache-Control: no-store`
4. Definir `@Throttle` explícitos — `GET /videos/:publicId` com limite 60 por minuto (polling do status) e `stream`, `download` e `thumbnail` com 120 por minuto — e documentar as quatro rotas com `@ApiOperation` e `@ApiResponse` por status (erros com `ApiErrorEnvelope`)
5. Criar o teste de compilação do `VideosModule` completo (módulo agora com controller, serviços e dependências)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDeliveryService` | Unit: apenas `ready`, sanitização do filename, ausência de thumbnail → `VIDEO_NOT_FOUND` | `src/videos/video-delivery.service.spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |
| `VideosController` | E2E: status do dono; `stream`, `download` e `thumbnail` seguindo o `Location` real no MinIO (`Range` → 206) | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.6 — módulo, serviço e storage de vídeo

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` sem token, de um vídeo `ready`, retorna `302` com `Location` e `Cache-Control: no-store`, e um `GET` nesse `Location` com `Range: bytes=0-99` retorna `206` com `Content-Range`
- `GET /videos/{publicId}/download` retorna `302`, e o `Location` responde com `Content-Disposition: attachment; filename="..."`
- `GET /videos/{publicId}/thumbnail` retorna `302`, e o `Location` responde com `Content-Type: image/jpeg`
- `stream`, `download` e `thumbnail` de um vídeo em `draft`, `processing` ou `error`, ou de um `publicId` inexistente, retornam `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/{publicId}` do dono retorna `200` com `status`, `durationSeconds` e `metadata`; de outro usuário retorna `404`; sem token retorna `401`
- Mais de 10 chamadas por minuto a `stream` e a `GET /videos/{publicId}` não retornam `429`
- As respostas de `stream` e `download` não carregam corpo de vídeo (são redirecionamentos)
- Um `original_filename` com aspas ou quebra de linha produz um `Content-Disposition` sem esses caracteres

---

### SI-03.9 — Implementar a reconciliação e a limpeza de uploads abandonados

**Description:** Fecha as lacunas de consistência entre banco e fila: re-enfileira vídeos presos em `processing` e remove rascunhos abandonados (abortando o multipart no storage), por uma varredura periódica agendada no BullMQ.

**Technical actions:**

1. Criar `src/videos/video-maintenance.service.ts` — `VideoMaintenanceService` com `reenqueueStuckProcessing(now)` (vídeos `processing` com `processing_started_at` anterior a `now - VIDEO_PROCESSING_STUCK_MINUTES` voltam à fila, idempotente pelo `jobId`) e `cleanupAbandonedDrafts(now)` (`draft` com `created_at` anterior a `now - VIDEO_DRAFT_TTL_DAYS` tem o multipart abortado e a linha removida) (per `phase-03-videos/TD-10`)
2. Criar `src/worker/video-maintenance.processor.ts` — `VideoMaintenanceProcessor` (`@Processor(VIDEO_MAINTENANCE_QUEUE)`) que executa as duas rotinas, isolando a falha de uma para não impedir a outra
3. Criar `src/worker/video-maintenance.scheduler.ts` — no `onApplicationBootstrap`, `queue.upsertJobScheduler('video-maintenance-sweep', { every: VIDEO_SWEEP_INTERVAL_MS }, { name: 'sweep', data: {} })`, idempotente entre reinícios (per `phase-03-videos/TD-10`)
4. Registrar serviço, processor e scheduler no `WorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMaintenanceService` | Integration (DB, MinIO e Redis reais): re-enqueue de `processing` travado uma única vez, `processing` recente intocado, draft antigo abortado e removido, draft recente mantido | `src/videos/video-maintenance.service.integration-spec.ts` |
| `VideoMaintenanceProcessor` | Unit: delega as duas rotinas e uma falha não impede a outra | `src/worker/video-maintenance.processor.spec.ts` |
| scheduler da varredura | Integration (Redis real): o scheduler existe com o intervalo configurado e não duplica ao ser registrado duas vezes | `src/worker/video-maintenance.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.7 — `WorkerModule`; SI-03.5 — fila; SI-03.4 — storage

**Acceptance criteria:**

- Um vídeo `processing` com `processing_started_at` mais antigo que o limite volta a ter um job `process-video`, exatamente um, mesmo que a varredura rode duas vezes
- Um vídeo `processing` recente não gera job
- Um `draft` mais antigo que `VIDEO_DRAFT_TTL_DAYS` tem o upload multipart abortado (não aparece em `ListMultipartUploads`) e a linha removida
- Um `draft` recente permanece intacto
- Depois de registrar o scheduler duas vezes, existe um único scheduler `video-maintenance-sweep` com `every` igual a `VIDEO_SWEEP_INTERVAL_MS`

---

### SI-03.10 — Exportar o OpenAPI, atualizar o CLAUDE.md, medir o upload de 10 GiB e fechar a Definition of Done

**Description:** Fecha a fase: spec OpenAPI com os novos endpoints, documentação de IA coerente com o código, verificação medida de um upload de 10 GiB e a suíte completa verde.

**Technical actions:**

1. Regenerar e commitar `nestjs-project/openapi.json` (`npm run openapi:export`) com os sete endpoints de vídeo (per `openapi-docs-nestjs/TD-02`)
2. Atualizar `nestjs-project/CLAUDE.md` e o `CLAUDE.md` da raiz com a seção de vídeos: módulos `videos/`, `storage/`, `queue/` e `worker/`, endpoints, fila e worker, serviços Compose `minio`, `redis` e `video-worker`, variáveis de ambiente, como rodar os testes que dependem do worker e a exceção `S3_PUBLIC_ENDPOINT=localhost` — citando somente arquivos e comandos que existem
3. Criar `nestjs-project/scripts/smoke-upload.sh`, executado no host só com `curl`: cria o vídeo, envia as partes direto às URLs assinadas, completa e acompanha o status até `ready` ou `error` (recebe `API_URL`, `ACCESS_TOKEN` e o arquivo; documenta como obter o token)
4. Executar o teste manual com um arquivo de 10 GiB (cerca de 10 GB livres em disco) e registrar no `progress.md` a duração, o número de partes, o status final e se `GET /` respondeu `200` durante o envio
5. Rodar a Definition of Done dentro do container — `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` — e registrar o resultado no `progress.md`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| documento OpenAPI exportado | Integration: contém os sete paths de vídeo e coincide com o `openapi.json` commitado | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.8, SI-03.9 — todos os endpoints e o worker precisam estar prontos

**Acceptance criteria:**

- `openapi.json` contém os paths `/videos`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}`, `/videos/{publicId}/stream`, `/videos/{publicId}/download` e `/videos/{publicId}/thumbnail`
- Cada arquivo e cada comando citados nos dois `CLAUDE.md` existem no repositório
- `smoke-upload.sh` com um arquivo de 10 GiB conclui o upload e o `complete` retorna `202`, `GET /` continua respondendo `200` durante todo o envio e o vídeo termina em `ready` quando o arquivo é um vídeo válido
- `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (código `0`) e `npm run lint` passam

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (new). Implemented by `src/videos/entities/video.entity.ts` and the migration `CreateVideos` generated with the TypeORM CLI (`typeorm-migrations` rule). Column names are `snake_case`, as in the existing `Channel`, `User` and token entities.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`) |
| public_id | varchar(11) | unique, not null — URL-safe random id used in every public URL (per `phase-03-videos/TD-09`) |
| channel_id | uuid | not null, FK → `channels.id` (the owning channel) |
| title | varchar(255) | nullable — a draft has no title; Phase 04 edits it (per `phase-03-videos/TD-04` Revision, AMB-1) |
| original_filename | varchar(255) | nullable — client filename, stored as metadata only, never as title |
| content_type | varchar(100) | nullable — type declared at upload start; a hint only, the worker validates the real container with `ffprobe` (per `phase-03-videos/TD-04`) |
| size_bytes | bigint | nullable — size declared at upload start (`1 ≤ n ≤ 10737418240`), re-verified at completion by summing the parts reported by storage (per `phase-03-videos/TD-04`); mapped to a TypeScript `number` with a column transformer |
| status | enum `videos_status_enum` | not null, default `'draft'`; values `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-10`) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; set at upload start, cleared at completion or cleanup; never returned to the client |
| source_key | varchar(255) | not null — `videos/{id}/source.{ext}` where `{id}` is `videos.id` (per `phase-03-videos/TD-02`) |
| thumbnail_key | varchar(255) | nullable — `thumbnails/{id}/default.jpg`, set when the worker finishes (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`) |
| duration_seconds | numeric(12,3) | nullable — own column, set by the worker (per `phase-03-videos/TD-07`); mapped to `number` with a column transformer |
| metadata | jsonb | nullable — `{ container, videoCodec, audioCodec, width, height, bitrate, sizeBytes }` extracted by `ffprobe` (per `phase-03-videos/TD-07`) |
| failure_reason | text | nullable — failure code (see Error Catalog → worker failure reasons), set only when `status = 'error'` (per `phase-03-videos/TD-10`) |
| processing_started_at | timestamp | nullable — set when the status becomes `processing`; read by the reconciliation sweep (per `phase-03-videos/TD-10`) |
| created_at | timestamp | not null, default `now()` (`@CreateDateColumn`) |
| updated_at | timestamp | not null, default `now()` (`@UpdateDateColumn`) |

**Relations:** `Video` many-to-one `Channel` through `channel_id`; `Channel` one-to-many `Video` (inverse side added to `channel.entity.ts` — the `typeorm`/entity rule requires both sides, and it changes no column).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (reconciliation and cleanup queries).
**Status transitions (enforced in `VideosService`, never in the controller):** `draft → processing` (upload completion), `processing → ready` and `processing → error` (worker). `ready` and `error` are terminal in this phase — there is no reprocess endpoint (per `phase-03-videos/TD-10`). A `draft` that is never completed is removed by the cleanup sweep.
**Object keys:** `videos/{id}/source.{ext}` and `thumbnails/{id}/default.jpg`, both in the single private bucket (per `phase-03-videos/TD-02`). `{ext}` comes from the declared `contentType`: `video/mp4` → `mp4`, `video/webm` → `webm`, `video/quicktime` → `mov` (plan-level allowlist; every entry needs a real fixture test in SI-03.7).
**Migration:** `CreateVideos` creates the enum type `videos_status_enum`, the table, the FK, the unique constraint and the indexes; its `down` drops the table **and** the enum type (a leftover enum type breaks re-running migrations — see the migration test fix in the baseline prerequisite).

### API Contracts

Backend tier only (no frontend in this phase). All responses and errors use the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`); `400` validation errors come from the existing `ValidationExceptionFilter`. The controller is `VideosController` (`@Controller('videos')`, `@ApiTags('videos')`); protected routes carry `@ApiBearerAuth('access-token')` and public routes `@Public()` (per `openapi-docs-nestjs/TD-01` and the controller rules). `{publicId}` is the 11-character URL id (per `phase-03-videos/TD-09`); the internal `videos.id` is never exposed.

#### POST /videos (SI-03.6)

Creates the draft and starts the S3 multipart upload. The channel is the authenticated user's channel (derived from the JWT `sub`), never taken from the body.

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 to 255 characters (stored in `original_filename`)
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`
- sizeBytes: integer, required — `1 ≤ n ≤ 10737418240` (10 GiB)

**Response 201:**
- publicId: string — the unique video URL id
- status: string — always `draft`
- partSizeBytes: integer — fixed at `67108864` (64 MiB) (per `phase-03-videos/TD-04`)
- partCount: integer — `ceil(sizeBytes / partSizeBytes)`; at most `160` for 10 GiB

**Error responses:**
- 401 Unauthorized: missing or invalid access token (global `JwtAuthGuard`)
- 400 validation error: body fails validation (including an unsupported `contentType`)
- 413 VIDEO_TOO_LARGE: `sizeBytes` is greater than 10 GiB
- 503 STORAGE_UNAVAILABLE: the multipart upload could not be created (no draft row is left behind)

---

#### POST /videos/{publicId}/upload/part-urls (SI-03.6)

Returns presigned `UploadPart` URLs signed for `S3_PUBLIC_ENDPOINT`; the client `PUT`s each part straight to storage (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`). The API never receives video bytes.

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1 to 100 unique items, each `1 ≤ n ≤ partCount`

**Response 200:**
- parts: array of `{ partNumber: integer, url: string }`
- expiresInSeconds: integer — `3600`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 400 validation error: body fails validation
- 400 INVALID_PART_NUMBER: a part number is greater than the video's `partCount`
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller (existence is not leaked)
- 409 VIDEO_INVALID_STATE: the video is not in `draft`

---

#### POST /videos/{publicId}/upload/complete (SI-03.6)

Completes the multipart upload, moves the video to `processing` and enqueues the processing job (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer {access token}
- Content-Type: application/json

**Request body:**
- parts: array of `{ partNumber: integer, etag: string }`, required — exactly `partCount` items, `partNumber` values `1..partCount`

**Response 202:**
- publicId: string
- status: string — always `processing`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 400 validation error: body fails validation
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller
- 409 VIDEO_INVALID_STATE: the video is not in `draft` (a second `complete` call lands here)
- 413 VIDEO_TOO_LARGE: the sum of the part sizes reported by storage is greater than 10 GiB
- 422 UPLOAD_PARTS_MISMATCH: the reported parts do not match the parts stored (`ListParts`)
- 422 UPLOAD_SIZE_MISMATCH: the sum of the stored part sizes differs from the declared `size_bytes`
- 503 STORAGE_UNAVAILABLE: storage could not complete the upload

---

#### GET /videos/{publicId} (SI-03.8)

Owner-only status and metadata of one video (used to follow `processing`).

**Request headers:**
- Authorization: Bearer {access token}

**Response 200:**
- publicId: string
- status: string — `draft`, `processing`, `ready` or `error`
- title: string or null
- originalFilename: string or null
- durationSeconds: number or null — set when `ready`
- metadata: object or null — `{ container, videoCodec, audioCodec, width, height, bitrate, sizeBytes }`, set when `ready`
- failureReason: string or null — set when `error`
- createdAt: string (ISO 8601)
- updatedAt: string (ISO 8601)

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or not owned by the caller

---

#### GET /videos/{publicId}/stream (SI-03.8)

Public. Authorizes the request and redirects to a short-lived presigned `GET` URL; storage answers `Range` requests natively with `206 Partial Content` (per `phase-03-videos/TD-08`). No video bytes pass through the API.

**Response 302:**
- Location: presigned `GET` URL for `source_key`, signed for `S3_PUBLIC_ENDPOINT`, valid 3600 seconds
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video is not `ready` (per `phase-03-videos/TD-11`)

---

#### GET /videos/{publicId}/download (SI-03.8)

Public. Same flow as `stream`; the presigned URL carries `ResponseContentDisposition: attachment; filename="..."` so the browser downloads the file (per `phase-03-videos/TD-08`). The filename is `original_filename` with quotes and control characters removed, falling back to `{publicId}.{ext}`.

**Response 302:**
- Location: presigned `GET` URL for `source_key` with `ResponseContentDisposition`, valid 3600 seconds
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video is not `ready`

---

#### GET /videos/{publicId}/thumbnail (SI-03.8)

Public. Redirects to a presigned `GET` URL for `thumbnail_key` (thumbnails stay private and signed, per `phase-03-videos/TD-02`).

**Response 302:**
- Location: presigned `GET` URL for `thumbnail_key`, valid 3600 seconds
- Cache-Control: no-store

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, the video is not `ready`, or it has no thumbnail

---

#### Validation Rules — videos

- `filename`: required string, 1 to 255 characters
- `contentType`: required string, one of `video/mp4`, `video/webm`, `video/quicktime`
- `sizeBytes`: required integer, `1 ≤ n ≤ 10737418240`
- `partNumbers`: required array of 1 to 100 unique integers, each `≥ 1` (the upper bound `partCount` is checked in `VideoUploadsService`)
- `parts[].partNumber`: required integer `≥ 1`; `parts[].etag`: required non-empty string
- `publicId` (path): 11 characters from `[A-Za-z0-9_-]`; any other value is answered as `404 VIDEO_NOT_FOUND`, not `400`
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) already applies (inherited from Phase 02)

### Authorization Matrix

`Owner` means the authenticated user whose channel owns the video (`videos.channel_id` → `channels.user_id` equals the JWT `sub`). Rules follow `phase-03-videos/TD-11`: write and status operations are owner-only; stream, download and thumbnail are public but only for `ready` videos. A caller who is not the owner gets the same `404 VIDEO_NOT_FOUND` as for an unknown id, so existence is not leaked. Authorization lives in `VideosService`/`VideoUploadsService` (ownership check), not in the controller or a guard.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (creates in the caller's own channel) | ✓ |
| POST /videos/{publicId}/upload/part-urls | ✗ | ✗ (404) | ✓ (while `draft`) |
| POST /videos/{publicId}/upload/complete | ✗ | ✗ (404) | ✓ (while `draft`) |
| GET /videos/{publicId} | ✗ | ✗ (404) | ✓ |
| GET /videos/{publicId}/stream | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (only `ready`) |
| GET /videos/{publicId}/download | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (only `ready`) |
| GET /videos/{publicId}/thumbnail | ✓ (only `ready`) | ✓ (only `ready`) | ✓ (only `ready`) |

**Rate limiting (inherited constraint):** the existing `ThrottlerGuard` is registered with `APP_GUARD` in `AuthModule`, which makes it global (`ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])`), and no controller overrides it today. Without an override, `part-urls` (up to ~160 calls for a 10 GiB file) would be answered with `429` after 10 calls per minute. `VideosController` must set explicit `@Throttle` limits: `part-urls` higher than the default, `stream`/`download`/`thumbnail` higher than the default; exact numbers are chosen in SI-03.6 and SI-03.8 and covered by an e2e test.

### Error Catalog

Error response format is inherited, not redefined: `{ statusCode, error, message }` where `error` is the domain `errorCode` (per `phase-02-auth/TD-07`, `DomainExceptionFilter`). New exceptions extend `DomainException` in `src/common/exceptions/domain.exception.ts` (the project keeps all domain exceptions in that file).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` unknown, caller is not the owner on an owner-only route, or the video is not `ready` on `stream`/`download`/`thumbnail` |
| VIDEO_INVALID_STATE | 409 | `part-urls` or `complete` called when the video is not `draft` |
| VIDEO_TOO_LARGE | 413 | Declared `sizeBytes` or the stored parts' total is greater than 10 GiB |
| INVALID_PART_NUMBER | 400 | A requested part number is greater than the video's `partCount` |
| UPLOAD_PARTS_MISMATCH | 422 | Parts sent to `complete` do not match the parts stored in S3 (`ListParts`) |
| UPLOAD_SIZE_MISMATCH | 422 | Sum of stored part sizes differs from the declared `size_bytes` |
| STORAGE_UNAVAILABLE | 503 | The storage service rejected or could not execute a multipart operation |

**Worker failure reasons.** These are not HTTP errors: they are persisted in `videos.failure_reason` when the worker gives up (`status = 'error'`, per `phase-03-videos/TD-10`).

| failure_reason | Retried | Trigger |
|----------------|---------|---------|
| NOT_A_VIDEO | no (non-retryable) | `ffprobe` finds no video stream or an unsupported container |
| SOURCE_MISSING | yes | The source object is absent in storage when the job runs |
| PROBE_FAILED | yes | `ffprobe` exits non-zero, times out or returns invalid JSON |
| THUMBNAIL_FAILED | yes | `ffmpeg` cannot produce the thumbnail |
| STORAGE_ERROR | yes | Reading the source or writing the thumbnail fails |

A retryable reason is recorded only after the job's attempts are exhausted; `NOT_A_VIDEO` ends the job at once through BullMQ's `UnrecoverableError`, which moves the job to failed without retries **[doc]** (see `library-refs.md`).

### Events/Messages

Two BullMQ queues on the same Redis (per `phase-03-videos/TD-03`). Queue and scheduler names are constants in `src/queue/queue.constants.ts`. Both queues are registered with `BullModule.registerQueueAsync` in `QueueModule` using the namespaced `queue` config (inherited `registerAs` convention); the producer side runs in the API, the consumers run only in the video worker (per `phase-03-videos/TD-06`).

#### video.processing.requested

Queue `video-processing`, job name `process-video`.

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` is the internal `videos.id` (never `public_id`). The worker reads everything else from the database, so a retried or late job never acts on stale data.

**Job options:** `jobId` = `videoId` (BullMQ ignores a second job with an existing id, giving one job per video); `attempts: 3`; `backoff: { type: 'exponential', delay: 5000 }` (attempts per `phase-03-videos/TD-10`; the 5000 ms delay is a plan default); `removeOnComplete: { count: 1000 }`, `removeOnFail: { count: 5000 }` (defaults from the project's `micro-use-queues` rule). The processor runs with `concurrency` taken from config (`VIDEO_WORKER_CONCURRENCY`, default `1`, because each job is I/O- and CPU-heavy).
**Producer:** `VideoQueueService` (called by `VideoUploadsService` after the `processing` status is committed, and by `VideoMaintenanceProcessor` for re-enqueue) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
**Consumer:** `VideoProcessingProcessor` in the video worker (per `phase-03-videos/TD-06`)
**Trigger:** the upload is completed and the video moves to `processing`; or the maintenance sweep finds a video stuck in `processing`.
**Delivery semantics:** at-least-once (retries plus stalled-job recovery), made safe by idempotence (per `phase-03-videos/TD-10`): the thumbnail and metadata are written to deterministic keys/columns, and the final status update is conditional (`WHERE status = 'processing'`), so a duplicate delivery changes nothing.
**Failure handling:** a thrown error is retried per the job options; when attempts are exhausted (`job.attemptsMade >= job.opts.attempts`, observed in `@OnWorkerEvent('failed')`) the worker sets `status = 'error'` and `failure_reason`; `UnrecoverableError` skips the retries (see Error Catalog → worker failure reasons).

#### video.maintenance.sweep

Queue `video-maintenance`, job name `sweep`, one job scheduler `video-maintenance-sweep` created by the worker at bootstrap with `queue.upsertJobScheduler(..., { every: VIDEO_SWEEP_INTERVAL_MS })` (default `300000` ms) **[doc]**. Using a BullMQ scheduler instead of `setInterval` follows the project's `micro-use-queues` rule.

**Payload:**

```json
{}
```

**Producer:** the video worker bootstrap (scheduler upsert; idempotent across restarts) (per `phase-03-videos/TD-10`)
**Consumer:** `VideoMaintenanceProcessor` in the video worker (per `phase-03-videos/TD-06`, `phase-03-videos/TD-10`)
**Trigger:** every `VIDEO_SWEEP_INTERVAL_MS`. Each run (a) re-enqueues `video.processing.requested` for videos in `processing` whose `processing_started_at` is older than `VIDEO_PROCESSING_STUCK_MINUTES` (default `30`), and (b) aborts the multipart upload and deletes the row of every `draft` older than `VIDEO_DRAFT_TTL_DAYS` (default `2`), closing the dual-write gap and the orphan-upload hole (per `phase-03-videos/TD-10`).
**Delivery semantics:** at-least-once; every action is idempotent (re-enqueue uses the same `jobId`; aborting an already-aborted upload is ignored).

---

## Dependency Map

**Pré-requisito externo (fora da numeração, em ramo próprio `bugfix/lint-baseline` mesclado na `dev` antes de SI-03.1):** deixar a base verde, já que a Definition of Done exige `npm run lint` e suíte verde — corrigir os erros de lint herdados da `main`, tornar `src/database/migrations.integration-spec.ts` independente de um tipo enum remanescente, definir `testTimeout` em `test/jest-e2e.json` e fazer `npm test` rodar em série (`--runInBand`).

```
SI-03.1 (no deps — após o pré-requisito externo)
└── SI-03.2 — depends on SI-03.1 (chaves de ambiente que os testes sobrescrevem)
    ├── SI-03.3 — depends on SI-03.2 (banco de teste isolado)
    └── SI-03.5 — depends on SI-03.1 + SI-03.2 (config de fila e prefixo de teste)

SI-03.1 + SI-03.3
└── SI-03.4 — depends on SI-03.1 (MinIO e config) + SI-03.3 (StorageUnavailableException)

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6 — depends on entidade, storage e fila
    ├── SI-03.7 — depends on SI-03.6 + SI-03.5 + SI-03.4 + SI-03.2 (upload alimenta o worker; fixtures)
    │   └── SI-03.9 — depends on SI-03.7 + SI-03.5 + SI-03.4 (WorkerModule, fila e storage)
    └── SI-03.8 — depends on SI-03.6 (módulo e serviços de vídeo)

SI-03.8 + SI-03.9
└── SI-03.10 — depends on todos os endpoints e o worker
```

Ordem linearizada de implementação: SI-03.1 → SI-03.2 → SI-03.3, SI-03.5 (paralelos) → SI-03.4 → SI-03.6 → SI-03.7, SI-03.8 (paralelos) → SI-03.9 → SI-03.10

---

## Deliverables

- [x] SI-03.1 — Instalar dependências, configurar namespaces e subir MinIO e Redis no Compose
- [x] SI-03.2 — Isolar a infraestrutura de testes e gerar fixtures de vídeo
- [x] SI-03.3 — Criar a entidade Video, a migration CreateVideos e as exceções de domínio
- [x] SI-03.4 — Criar o StorageModule e o StorageService (S3)
- [x] SI-03.5 — Criar o QueueModule e o produtor de jobs de vídeo
- [x] SI-03.6 — Implementar o fluxo de upload: rascunho, URLs de partes e conclusão
- [x] SI-03.7 — Implementar o worker de vídeo: metadados, thumbnail e ciclo de status
- [x] SI-03.8 — Implementar a entrega: status do vídeo, streaming, download e thumbnail
- [x] SI-03.9 — Implementar a reconciliação e a limpeza de uploads abandonados
- [x] SI-03.10 — Exportar o OpenAPI, atualizar o CLAUDE.md, medir o upload de 10 GiB e fechar a Definition of Done

**Full test suites:**

- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [x] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
