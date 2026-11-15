# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/10 completed

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
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.4 — Criar o StorageModule e o StorageService (S3)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — Criar o QueueModule e o produtor de jobs de vídeo
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — Implementar o fluxo de upload: rascunho, URLs de partes e conclusão
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — Implementar o worker de vídeo: metadados, thumbnail e ciclo de status
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — Implementar a entrega: status do vídeo, streaming, download e thumbnail
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Implementar a reconciliação e a limpeza de uploads abandonados
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Exportar o OpenAPI, atualizar o CLAUDE.md, medir o upload de 10 GiB e fechar a Definition of Done
- **Status:** pending
- **Tests:** pending
- **Observations:** none

