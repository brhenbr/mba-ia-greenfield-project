#!/usr/bin/env bash
# Manual smoke test of the video upload flow, run on the HOST with only curl:
#   POST /videos -> PUT every part straight to the presigned URLs ->
#   POST .../upload/complete -> poll GET /videos/:publicId until ready|error.
#
# Usage:
#   API_URL=http://localhost:3000 ACCESS_TOKEN=<jwt> ./scripts/smoke-upload.sh path/to/video.mp4
#
# Getting an access token (the API must be running: `docker compose exec nestjs-api npm run start:dev`):
#   1. curl -X POST $API_URL/auth/register -H 'Content-Type: application/json' \
#        -d '{"email":"me@example.com","password":"password123"}'
#   2. Open the confirmation link in the e-mail captured by Mailpit (http://localhost:8025).
#   3. curl -X POST $API_URL/auth/login -H 'Content-Type: application/json' \
#        -d '{"email":"me@example.com","password":"password123"}'   # -> access_token
#
# The access token lives only JWT_ACCESS_EXPIRATION (15 minutes by default); a large upload takes
# longer. Pass the `refresh_token` from the login response as REFRESH_TOKEN and the script renews
# the token pair (POST /auth/refresh) every 10 minutes, as a real client would.
#
# Optional environment:
#   REFRESH_TOKEN  refresh token used to renew ACCESS_TOKEN during long uploads
#   CONTENT_TYPE   video/mp4 | video/webm | video/quicktime (default: from the file extension)
#   POLL_TIMEOUT   seconds to wait for ready|error after complete (default 900)
#   HEALTH_URL     URL probed every 5 s during the upload (default $API_URL/); the result
#                  is reported at the end so a blocked API is noticed
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
FILE="${1:-}"
POLL_TIMEOUT="${POLL_TIMEOUT:-900}"
HEALTH_URL="${HEALTH_URL:-$API_URL/}"

die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${ACCESS_TOKEN:-}" ] || die "ACCESS_TOKEN is required (see the header of this script)"
[ -n "$FILE" ] && [ -f "$FILE" ] || die "usage: $0 <video file>"

SIZE=$(wc -c < "$FILE" | tr -d ' ')
if [ -z "${CONTENT_TYPE:-}" ]; then
  case "${FILE##*.}" in
    mp4) CONTENT_TYPE=video/mp4 ;;
    webm) CONTENT_TYPE=video/webm ;;
    mov) CONTENT_TYPE=video/quicktime ;;
    *) die "cannot infer the content type from the extension; set CONTENT_TYPE" ;;
  esac
fi

AUTH=(-H "Authorization: Bearer $ACCESS_TOKEN")
JSON=(-H "Content-Type: application/json")
WORK=$(mktemp -d)
HEALTH_LOG="$WORK/health.log"
trap 'kill "${HEALTH_PID:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Tiny JSON readers (no jq on purpose): string and integer fields of a flat object.
json_str() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" <<<"$2" | head -1; }
json_num() { sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" <<<"$2" | head -1; }

TOKEN_AT=$(date +%s)
# Renews the token pair when it is older than 10 minutes (refresh tokens rotate).
renew_token_if_needed() {
  [ -n "${REFRESH_TOKEN:-}" ] || return 0
  [ $(( $(date +%s) - TOKEN_AT )) -gt 600 ] || return 0
  local body
  body=$(curl -sS "${JSON[@]}" -X POST -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}" "$API_URL/auth/refresh")
  ACCESS_TOKEN=$(json_str access_token "$body")
  REFRESH_TOKEN=$(json_str refresh_token "$body")
  [ -n "$ACCESS_TOKEN" ] || die "token refresh failed: $body"
  AUTH=(-H "Authorization: Bearer $ACCESS_TOKEN")
  TOKEN_AT=$(date +%s)
  echo; echo "(access token renewed)"
}

# POST with a JSON body; prints "<status>\n<body>"
post() { curl -sS -o "$WORK/body" -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST -d "$2" "$API_URL$1"; echo; cat "$WORK/body"; echo; }

START=$(date +%s)
echo "File: $FILE ($SIZE bytes, $CONTENT_TYPE)"

# Health probe in the background: proves the API keeps answering during the upload.
(
  while true; do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" || echo 000)
    echo "$code" >> "$HEALTH_LOG"
    sleep 5
  done
) &
HEALTH_PID=$!

# 1. Create the draft.
FILENAME=$(basename "$FILE")
RESPONSE=$(post /videos "{\"filename\":\"$FILENAME\",\"contentType\":\"$CONTENT_TYPE\",\"sizeBytes\":$SIZE}")
STATUS=$(sed -n 1p <<<"$RESPONSE"); BODY=$(sed -n 2p <<<"$RESPONSE")
[ "$STATUS" = "201" ] || die "POST /videos answered $STATUS: $BODY"
PUBLIC_ID=$(json_str publicId "$BODY")
PART_SIZE=$(json_num partSizeBytes "$BODY")
PART_COUNT=$(json_num partCount "$BODY")
echo "Draft $PUBLIC_ID: $PART_COUNT parts of $PART_SIZE bytes"

# 2. Upload every part straight to storage (the API never sees the bytes).
PARTS_JSON=""
BATCH=20
part=1
while [ "$part" -le "$PART_COUNT" ]; do
  last=$((part + BATCH - 1)); [ "$last" -gt "$PART_COUNT" ] && last=$PART_COUNT
  numbers=$(seq -s, "$part" "$last")
  renew_token_if_needed
  RESPONSE=$(post "/videos/$PUBLIC_ID/upload/part-urls" "{\"partNumbers\":[$numbers]}")
  STATUS=$(sed -n 1p <<<"$RESPONSE"); BODY=$(sed -n 2p <<<"$RESPONSE")
  [ "$STATUS" = "200" ] || die "part-urls answered $STATUS: $BODY"

  for n in $(seq "$part" "$last"); do
    # Part n looks like {"partNumber":n,"sizeBytes":N,"url":"..."}. The URL is signed for
    # exactly N bytes (Content-Length), which is what `dd` + `curl -T` send below.
    url=$(sed -n "s/.*{\"partNumber\":$n,\"sizeBytes\":[0-9]*,\"url\":\"\([^\"]*\)\".*/\1/p" <<<"$BODY" | head -1)
    [ -n "$url" ] || die "no URL returned for part $n"
    # Extract the part to a file so curl sends a Content-Length (S3 rejects chunked PUTs).
    dd if="$FILE" of="$WORK/part" bs="$PART_SIZE" skip=$((n - 1)) count=1 2>/dev/null
    code=$(curl -sS -o /dev/null -D "$WORK/headers" -w '%{http_code}' -T "$WORK/part" "$url")
    [ "$code" = "200" ] || die "PUT of part $n answered $code"
    etag=$(grep -i '^etag:' "$WORK/headers" | head -1 | cut -d' ' -f2- | tr -d '\r\n')
    [ -n "$etag" ] || die "no ETag returned for part $n"
    escaped=${etag//\"/\\\"}
    PARTS_JSON="${PARTS_JSON:+$PARTS_JSON,}{\"partNumber\":$n,\"etag\":\"$escaped\"}"
    printf '\rUploaded part %s/%s' "$n" "$PART_COUNT"
  done
  part=$((last + 1))
done
echo

# 3. Complete the upload.
renew_token_if_needed
RESPONSE=$(post "/videos/$PUBLIC_ID/upload/complete" "{\"parts\":[$PARTS_JSON]}")
STATUS=$(sed -n 1p <<<"$RESPONSE"); BODY=$(sed -n 2p <<<"$RESPONSE")
echo "complete -> $STATUS $BODY"
[ "$STATUS" = "202" ] || die "complete answered $STATUS"
UPLOAD_END=$(date +%s)

# 4. Follow the processing until ready|error.
FINAL=""
deadline=$((UPLOAD_END + POLL_TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  renew_token_if_needed
  body=$(curl -sS "${AUTH[@]}" "$API_URL/videos/$PUBLIC_ID")
  state=$(json_str status "$body")
  echo "status: $state"
  if [ "$state" = "ready" ] || [ "$state" = "error" ]; then FINAL="$state"; break; fi
  sleep 5
done

kill "$HEALTH_PID" 2>/dev/null || true
total=$(wc -l < "$HEALTH_LOG" | tr -d ' '); ok=$(grep -c '^200$' "$HEALTH_LOG" || true)
echo "---"
echo "Upload: $((UPLOAD_END - START)) s for $SIZE bytes in $PART_COUNT parts"
echo "GET $HEALTH_URL during the run: $ok/$total answered 200"
echo "Final status: ${FINAL:-timeout after ${POLL_TIMEOUT}s} (video $PUBLIC_ID)"
[ -z "$FINAL" ] && exit 2
echo "Details: $body"
[ "$FINAL" = "ready" ]
