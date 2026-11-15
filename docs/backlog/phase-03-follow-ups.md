# Fase 03 — Pendências e requisitos para as próximas fases

Registro, feito ao fechar a Fase 03 (Upload e Processamento de Vídeos), de tudo o que foi encontrado e **não** foi implementado por estar fora do escopo do PRD da fase. Nada aqui é comportamento existente: são insumos para o próximo PRD e para tarefas de correção. Cada item cita a origem (código, teste ou artefato da fase) e, quando houver, a fase do `docs/project-plan.md` que o absorve.

Regra seguida: dentro da Fase 03 só entrou o que era escopo ou o que impactava a entrega (veja "Corrigido durante o fechamento" no fim). O resto está aqui.

---

## A. Requisitos para as próximas fases (features)

| # | Requisito | Origem / evidência | Fase que absorve |
|---|-----------|--------------------|------------------|
| A1 | **Visibilidade e publicação.** Hoje `stream`, `download` e `thumbnail` são públicos para qualquer vídeo `ready` (`VideosService.findReadyByPublicId`). Quando existir visibilidade (público / unlisted) e o fluxo rascunho → publicação, o acesso público deve depender dela, não só de `ready`. Um vídeo `ready` ainda não publicado **não** pode ser servido a anônimos. Exige nova coluna (ex.: `visibility`, `published_at`) + migration + atualização da Authorization Matrix. | `src/videos/videos.service.ts`; Authorization Matrix do plano; `docs/project-plan.md` Fase 04 (visibilidade, rascunho → publicação) e Fase 05 (unlisted só via link) | Fase 04 |
| A2 | **Edição das informações do vídeo.** `title` já é nulo no rascunho e `original_filename` fica guardado como metadado, sem virar título (decisão AMB-1). Faltam endpoint de edição (título, descrição, categoria), categorias e thumbnail customizada (substituir `thumbnail_key` por upload do dono). | TD-04 Revision / AMB-1 em `docs/decisions/technical-decisions-phase-03-videos.md`; `docs/project-plan.md` Fase 04 | Fase 04 |
| A3 | **Cota de armazenamento por usuário.** Não há limite do total armazenado por canal. Mitigação atual: URLs de parte com tamanho exato assinado, `VIDEO_MAX_OPEN_DRAFTS` (20) e a varredura de rascunhos abandonados. Decidir o valor da cota (decisão de produto) e aplicá-lo no início do upload. | `progress.md` (seção "Post-implementation hardening"); `nestjs-project/CLAUDE.md` ("Security decisions") | Fase 04 |
| A4 | **Reprocessar e política de retenção para vídeos em `error`.** `ready` e `error` são terminais e o arquivo de origem de um vídeo em `error` permanece no storage sem prazo. Definir endpoint de reprocessamento e/ou retenção com limpeza na varredura de manutenção. | `VideoMaintenanceService` (só trata `processing` preso e `draft` abandonado); TD-10 | Fase 04 |
| A5 | **Contrato para o player e o upload no frontend.** (a) Enviar cada parte com `Content-Length` igual ao `sizeBytes` devolvido em `part-urls` (a URL é assinada para esse tamanho; outro tamanho = 403). (b) Pedir URLs de parte em lotes pequenos: a validade é de 1 h (`S3_PRESIGN_EXPIRES_SECONDS`) e um envio lento pode vencer URLs já emitidas. (c) O player deve pedir de novo o redirect de `stream` se o storage responder 403 (URL vencida) no meio da reprodução. (d) Interface de vídeo e botão de download. | `StorageService.presignUploadPart`; `test/videos-upload.e2e-spec.ts`; `nestjs-project/CLAUDE.md`; PRD: interface fora da Fase 03 | Fase 05 |
| A6 | **Contagem de visualizações e sugestões.** Nenhum contador de views existe; a leitura por `stream` é redirecionada ao storage e não passa pela API, então a contagem precisa de um evento explícito do player. | `docs/project-plan.md` Fase 05 | Fase 05 |

## B. Preparação para produção (operação)

Não implementado: o ambiente do projeto é de desenvolvimento.

| # | Item | Origem |
|---|------|--------|
| B1 | Usar **S3 real** (o `bitnamilegacy/minio` do Compose é imagem congelada e sem patches de segurança: o MinIO upstream foi arquivado; SeaweedFS é a alternativa registrada em TD-01). O código só fala S3, sem mudança de API. | TD-01; `library-refs.md` |
| B2 | **Credenciais de menor privilégio.** O Compose usa o usuário root do MinIO como credencial da aplicação. Em produção, usar um usuário IAM restrito ao bucket (`PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload`, `ListMultipartUploadParts`, `ListBucket`), com o bucket criado previamente (`ensureBucket` falha rápido se faltar permissão). | `compose.yaml`; `StorageService.ensureBucket` |
| B3 | **CORS do bucket** restrito à origem do frontend (métodos `PUT`, `GET`, `HEAD`; expor `ETag` e `Content-Range`). No MinIO de desenvolvimento o padrão aceita qualquer origem. | spike do `library-refs.md` |
| B4 | **Limite de requisições com mais de uma instância da API.** O `ThrottlerGuard` guarda os contadores em memória (por processo); com réplicas, usar armazenamento no Redis (já existe no Compose) e configurar `trust proxy` atrás de balanceador. | `AuthModule` (`ThrottlerModule.forRoot`) |
| B5 | **Segredos.** `JWT_SECRET` e `JWT_REFRESH_SECRET` do `.env.example` são valores de exemplo e o Joi não exige força mínima; exigir segredos fortes quando `NODE_ENV=production`. | `src/config/env.validation.ts` (herdado da Fase 02) |
| B6 | **Imagem do worker pré-compilada.** Em desenvolvimento o worker usa `nest start --watch` (a primeira compilação leva minutos no bind mount do Windows). Em produção, imagem com o build já feito (`node dist-worker/...`), sem bind mount. | `Dockerfile.worker`; `package.json` (`start:worker`) |

## C. Correções e dívida técnica encontradas (fora do escopo da fase)

| # | Problema | Origem | Sugestão |
|---|----------|--------|----------|
| C1 | `channels.service.ts` mantém uma cópia privada de `isPgUniqueViolationOnColumn`, já extraída para `src/common/database/pg-errors.ts`. | `src/channels/channels.service.ts` | Trocar pela função compartilhada (refactor isolado, sem mudança de comportamento). |
| C2 | `openapi.json` sai com os schemas dos DTOs de **request** vazios (`properties: {}`), porque `npm run openapi:export` roda via `ts-node`, sem o plugin do Swagger (que só atua no `nest build`). Os DTOs de resposta saem completos (usam `@ApiProperty`). Vale para `auth` (Fase 02) e `videos`. | `src/openapi-export.ts`; `openapi.json` | Exportar a partir do build compilado (`nest build` + `node dist/...`). |
| C3 | O worker trata como `PROBE_FAILED` (3 tentativas) um arquivo que o `ffprobe` abre mas não consegue decodificar (ex.: `Invalid pixel format`), embora uma nova tentativa nunca resolva. | teste manual de 10 GiB no `progress.md` (SI-03.10) | Classificar erros de decodificação determinísticos como `NOT_A_VIDEO` (sem retry). |
| C4 | `ListMultipartUploads` com `Prefix` devolve lista vazia no MinIO usado (sem prefixo, lista tudo). | `src/test/clean-storage.ts`; `video-maintenance.service.integration-spec.ts` | Manter o filtro no cliente; reavaliar ao trocar de storage. |
| C5 | `nest start --watch` não percebe edições feitas no host em bind mounts do Windows; é preciso `docker compose restart video-worker`. | `nestjs-project/CLAUDE.md` | Habilitar polling do watcher no container do worker. |
| C6 | `@nestjs/bullmq` 12 e `@nestjs/bull-shared` são apenas ESM; o Jest depende de `test/esm-to-cjs.transformer.js`. | `package.json` (jest) | Remover o transformer quando o Jest/ts-jest carregar ESM nativamente. |
| C7 | A suíte completa leva ~25 min neste ambiente (bind mount + boot do `AppModule` com DB, MinIO e Redis); vários hooks precisaram de timeouts maiores (`testTimeout` 60 s; hook do `openapi-export` 120 s). | `package.json`; `src/openapi-export.integration-spec.ts` | Volume nomeado para `node_modules`; pré-compilar para os testes. |

## D. Corrigido durante o fechamento (porque impactava a entrega)

Validado em um **clone limpo** do fork, repetindo o que um avaliador faria (`docker compose up -d`, `cp .env.example .env`, `npm install`):

- `cp .env.example .env` quebrava **todo** comando `docker compose` (valor de `MAIL_FROM` sem aspas simples). Corrigido em `nestjs-project/.env.example`.
- Sem `.env`, as variáveis do MinIO no `compose.yaml` ficavam em branco. Agora têm padrões iguais aos do `.env.example`.
- O `video-worker` terminava com `nest: not found` (código 127) e não voltava sozinho antes do `npm install`. Agora `restart: on-failure`.
