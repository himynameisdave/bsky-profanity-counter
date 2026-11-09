-- Run with psql -X -v ON_ERROR_STOP=1. Reports contain processing history;
-- save them securely. Nothing here changes Mention rows.
CREATE OR REPLACE TEMP VIEW invalid_mention_uris AS
SELECT * FROM "Mention"
WHERE "postUrl" IS NULL
   OR octet_length("postUrl") > 8192
   OR "postUrl" !~ '^at://did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]/app[.]bsky[.]feed[.]post/[A-Za-z0-9._~:-]+$'
   OR octet_length(split_part("postUrl", '/', 3)) > 2048
   OR octet_length(split_part("postUrl", '/', 5)) > 512
   OR split_part("postUrl", '/', 5) IN ('.', '..');

CREATE OR REPLACE TEMP VIEW duplicate_mention_uris AS
SELECT "postUrl", count(*) AS rows
FROM "Mention"
GROUP BY "postUrl"
HAVING count(*) > 1;

SELECT * FROM invalid_mention_uris ORDER BY "id";
SELECT m.* FROM "Mention" m
JOIN duplicate_mention_uris d ON d."postUrl" = m."postUrl"
ORDER BY m."postUrl", m."id";

DO $$
BEGIN
  IF EXISTS (SELECT FROM invalid_mention_uris) THEN
    RAISE EXCEPTION 'Invalid full mention URIs: stop and reconcile from verified source records; do not reset processing state';
  END IF;
  IF EXISTS (SELECT FROM duplicate_mention_uris) THEN
    RAISE EXCEPTION 'Duplicate full mention URIs: stop and reconcile history explicitly; do not delete or requeue mentions';
  END IF;
END $$;
