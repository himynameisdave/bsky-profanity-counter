# Mention URI identity rollout

`Mention.postUrl` already stores the full AT URI. Use those values directly:
create unique `Mention_postUrl_key`, then drop unique `Mention_postId_key`.
`postId` stays as a non-unique record key. No mention rows, statuses, attempts,
target DIDs, analyses, reply references, or timestamps are changed.

This PR is stacked on #60. Merge and deploy #60 first, following
[`issue-12-rollout.md`](issue-12-rollout.md), including its identity backfill.
Do not combine the two schema rollouts with an unchecked `db:push`.

## Stop old code before merging

The bot runs on pushes to `main` too. From the repository root, using `gh`
authenticated to `himynameisdave/bsky-profanity-counter`:

```bash
gh workflow disable scheduled-run.yml --repo himynameisdave/bsky-profanity-counter
```

Wait for **all** existing runs, including queued runs, to complete. Repeat the
list until it is empty; check all pages if there are more than 100 active runs.
Do not cancel a process in the middle of posting a reply.

```bash
gh run list --repo himynameisdave/bsky-profanity-counter --workflow scheduled-run.yml --limit 100 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' |
  while read -r run_id; do
    gh run watch "$run_id" --repo himynameisdave/bsky-profanity-counter
  done
```

Stop any local/manual mention writers as well, and keep them stopped. Profile
updates do not write mentions and can continue. No old build may resume after
`postId` uniqueness is removed: its generated Prisma client still treats that
field as unique. Do not manually dispatch an old workflow ref.

## Back up, preflight, and apply

Use Node 22+, pnpm 10, PostgreSQL client tools, and a securely loaded production
`DATABASE_URL`. The URL passed to `psql`/`pg_dump` must be libpq-compatible (no
Prisma-only query parameters such as `schema` or `connection_limit`); this
application uses the `public` schema. Never put credentials in the PR or logs.

Merge this PR, then check out the merged `main`. These commands use the existing
full URI; there is no network lookup or identity inference:

```bash
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm build
umask 077
pg_dump "$DATABASE_URL" --format=custom --file=../issue-11-before.dump
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f prisma/mention-uri-preflight.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f prisma/mention-uri-rollout.sql
pnpm db:push
```

Run each command only if the previous command succeeded. Keep the backup outside
the checkout. `prisma:generate` generates the client, not the database schema.
The targeted SQL changes only the two mention indexes, checks again under a table
lock, and commits both changes together. The final `db:push` should report the
database is already in sync; stop and investigate any other proposed changes.
There are no Prisma migration files in this repository, so
`prisma:migrate:deploy` does not apply this change. No `--accept-data-loss` flag
is needed after the targeted SQL.

The preflight prints full rows for duplicate or invalid URIs and exits non-zero
before changing any indexes. It accepts DID-based `app.bsky.feed.post` URIs with
valid record-key characters/length, and rejects empty keys, `.`/`..`, web URLs,
query strings, fragments, and extra path components. It is a structural check;
it does not prove the post exists. Keep reports restricted, since they contain
processing metadata.

If it fails, **leave writers stopped and the schema unchanged**:

- For an invalid URI, recover the exact canonical URI from independently verified
  source records. Review an explicit correction to `postUrl` only; retain the row
  ID and all processing history. Do not guess a repository from `postId` or a
  mutable handle.
- For a duplicate full URI, inspect every row's state, attempts, target DID,
  analysis link, and reply references. If the source proves a URI was recorded
  incorrectly, correct only that URI. If multiple rows really represent the same
  post, this rollout deliberately blocks: prepare a separate reviewed archival
  and reconciliation plan retaining **all** history and relationships. Do not
  pick an arbitrary survivor, delete rows, reset statuses, or requeue completed
  mentions to get past the check.

Rerun both preflight and rollout only after a reviewed reconciliation. A lock
or statement timeout rolls the rollout back; investigate before retrying. If a
previous rollout already committed, skip the rollout script (it intentionally
fails on an existing index) and verify the indexes instead:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Mention' ORDER BY indexname;"
```

Expect a unique `Mention_postUrl_key` and no `Mention_postId_key`; retain the
primary key and #60's status/creation index.

## Resume with the new client and code

Only after the schema is in sync, all old processes are gone, and the new build
succeeds:

```bash
gh workflow enable scheduled-run.yml --repo himynameisdave/bsky-profanity-counter
gh workflow run scheduled-run.yml --ref main --repo himynameisdave/bsky-profanity-counter
```

Check the run's ingestion/processing summary and failures. Replays must preserve
existing `DONE`/`FAILED` rows and their metadata. If rollback is needed, disable
and drain writers again; do not restore the old app blindly. New rows may share
`postId`, so restoring its unique index or the old client may be impossible
without losing valid requests. Prefer a forward fix while retaining URI identity.

This migration **does not recover requests already discarded** by the old
collision bug. Any historical recovery needs a separately reviewed source and
replay plan. #11's fetched-batch cursor, sequential order, persistence-failure
barrier, fully-read-page stop, and bounded pagination remain as before. The
existing seven-day/25-page cap can still leave older unread requests behind;
this change does not extend that recovery window.

## Opt-in database regression tests

Unit tests mock the APIs and database. For the additional real unique-index and
concurrency checks, point `DATABASE_URL` at a **disposable test database** with the
new schema (never production):

```bash
pnpm prisma:generate
pnpm db:push
MENTION_IDENTITY_DATABASE_TESTS=1 pnpm test test/database/mention-identity.integration.test.ts
```

The suite uses mocked Bluesky APIs, creates uniquely named fixtures, and removes
only those fixtures afterwards. Without both the flag and `DATABASE_URL`, it is
skipped, following the repository's `describe.skipIf` convention.
