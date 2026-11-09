-- Writers must be stopped, including queued runs of old application code.
-- Any error rolls back both index changes. This also works on an empty table.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE "Mention" IN ACCESS EXCLUSIVE MODE;

-- Repeat the preflight under the same lock as the index changes.
\ir mention-uri-preflight.sql

CREATE UNIQUE INDEX "Mention_postUrl_key" ON "Mention"("postUrl");
DROP INDEX "Mention_postId_key";
COMMIT;
