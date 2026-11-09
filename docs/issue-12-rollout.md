> [!WARNING]
> Disable both writers **before merging** (the bot also runs on pushes to `main`).
> Run from the repository root with Node 22, pnpm 10, `gh`, `pg_dump`, and the
> production `DATABASE_URL`, `BLUESKY_IDENTIFIER`, and `BLUESKY_PASSWORD` loaded
> securely in your environment. Do not print credentials.
>
> ```bash
> gh workflow disable scheduled-run.yml --repo himynameisdave/bsky-profanity-counter
> gh workflow disable update-profile.yml --repo himynameisdave/bsky-profanity-counter
> ```
>
> Wait for every existing run of these workflows to finish, including queued runs:
>
> ```bash
> for workflow in scheduled-run.yml update-profile.yml; do
>   gh run list --repo himynameisdave/bsky-profanity-counter --workflow "$workflow" --limit 100 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' |
>     while read -r run_id; do
>       gh run watch "$run_id" --repo himynameisdave/bsky-profanity-counter
>     done
> done
> ```
>
> Stop any local/manual bot or profile processes too. Back up the database; retain
> the dump outside the checkout with restricted permissions:
>
> ```bash
> umask 077
> pg_dump "$DATABASE_URL" --format=custom --file=../issue-12-before.dump
> ```
>
> Merge, then check out the merged `main` and deploy **in this order**:
>
> ```bash
> git switch main
> git pull --ff-only origin main
> pnpm install --frozen-lockfile
> pnpm prisma:generate
> pnpm db:push --accept-data-loss
> pnpm build
> node dist/backfill-identity.js --dry-run
> node dist/backfill-identity.js --apply
> node dist/backfill-identity.js --dry-run
> ```
>
> `db:push` applies the schema; `prisma:generate` only generates the client. This
> repo ignores `prisma/migrations/`, so do not use `prisma:migrate:deploy` for this
> change. The acknowledgement flag covers Prisma's unique-index warning: the new
> nullable `Analysis.did` starts empty, so it cannot contain duplicate non-null
> values. Only these schema changes are expected: nullable `did` on both tables,
> `Mention.lastError`, unique `Analysis.did`, removal of unique `Analysis.userHandle`,
> and the `[status, createdAt]` mention index. Stop if the checkout has other schema
> changes. No rows are deleted by this rollout.
>
> Review the first dry-run counts before applying. The apply runs atomically with
> a two-minute transaction timeout; a timeout rolls back all backfill changes.
> The second dry run should show the same active/quarantined totals and zero
> newly failed mentions. Do not restart writers if the apply fails.
>
> After a successful backfill, re-enable writers and run the new bot once:
>
> ```bash
> gh workflow enable scheduled-run.yml --repo himynameisdave/bsky-profanity-counter
> gh workflow enable update-profile.yml --repo himynameisdave/bsky-profanity-counter
> gh workflow run scheduled-run.yml --ref main --repo himynameisdave/bsky-profanity-counter
> ```

Fixes #12 by using DIDs for targets, cache keys, incremental recounts, reply facets,
and the bot's own identity. Keeps handles verbatim for display, refreshes them on
cached and fresh replies, and saves errors while keeping the existing retry budget.

The nullable fields are intentional: `null` quarantines historical data with no
proven identity. New ingestion and analysis writes require a DID. A legacy mention
that reaches processing without one fails explicitly rather than resolving its old
handle. Quarantined analyses are excluded from all cache lookups and profile totals.

The backfill never resolves handles or calls Bluesky. It uses `profanityDetails.did`
as analysis provenance. Where an existing canonical DID conflicts with those details,
it quarantines the snapshot. Analyses without provenance are kept with `did = null`,
with an `identityBackfill` reason in their JSON; the next request does a full count.

For multiple snapshots of a DID, it selects the newest `lastAnalyzedAt` (ID ascending
breaks ties) as one complete snapshot, retaining its totals, daily buckets, checkpoint
and `fullCountAt`. It never sums totals or mixes checkpoints. Other snapshots get a
null DID and an `identityBackfill` marker pointing to the canonical ID; markers prevent
reruns from reactivating them. Every row and existing `Mention.analysisId` relationship
stays intact, including links to archived snapshots. Those links are historical only;
runtime cache lookup always uses the target DID. Archived snapshots remain available
until the existing optional old-analysis cleanup is explicitly used.

For direct mentions, a DID-based original post URI proves the author. For historical
replies, the requesting post's URI proves only the requester: it does not prove the
parent author or that the deleted-parent fallback was used. The backfill does not copy
identity from potentially misattributed old cache relationships. Replies with no
already-recorded target DID stay unidentified; pending ones become `FAILED` with an
explanation. `DONE`/`FAILED` statuses, attempts, first-attempt times, reply references,
analysis relationships, and original row timestamps are retained. The backfill does not replay old replies.
Users can submit a new request if an ambiguous old request was quarantined.

This deliberately trades some historical cache coverage/profile totals for correct
attribution. Recovering those ambiguous identities would require separately reviewed
original-post/parent provenance; it is not required to run safely. Do not restore old
handles as keys. If rollback is needed, keep writers disabled: the old binary cannot
use the new schema's non-unique handles. Restore the backup into a separate database,
verify it, and point the old release at that restored database before restarting.

The existing five-failure **and** 24-hour window stays unchanged, including attempts
interrupted by killed runs. Known blocked/missing/deactivated accounts and invalid
outgoing records fail immediately; text over Bluesky's limits is rejected locally.
Unknown errors, network failures, rate limits and server errors keep their retries.
Deleted mentioning posts still finish without a reply. `lastError` retains the latest
failure, including after a successful retry, for history.

#11's full-URI deduplication and #20's consent/cooldowns are unchanged. #57's word
masking and #58's counting/checkpoints remain in use.
