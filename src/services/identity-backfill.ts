import type { Analysis, Mention, Prisma } from '../generated/prisma/client.js';

/** Archived because another analysis of the same DID was kept instead. */
export const DUPLICATE_SNAPSHOT_REASON = 'Duplicate DID snapshot';

const isDid = (value: unknown): value is string =>
  typeof value === 'string' && /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/u.test(value);

const asObject = (value: Prisma.JsonValue): Prisma.JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** A pure, reviewable plan. Never resolves a historical handle over the network. */
export function planIdentityBackfill(analyses: Analysis[], mentions: Mention[]) {
  const groups = new Map<string, Analysis[]>();
  const analysisUpdates: {
    id: string;
    did: string | null;
    updatedAt: Date;
    profanityDetails: Prisma.InputJsonObject;
  }[] = [];

  const quarantine = (row: Analysis, reason: string, canonicalAnalysisId?: string) => {
    const details = asObject(row.profanityDetails);
    analysisUpdates.push({
      id: row.id,
      did: null,
      updatedAt: row.updatedAt,
      profanityDetails: {
        ...(Object.keys(details).length > 0 ? details : { legacyDetails: row.profanityDetails }),
        identityBackfill: { reason, ...(canonicalAnalysisId ? { canonicalAnalysisId } : {}) },
      },
    });
  };

  for (const row of analyses) {
    const details = asObject(row.profanityDetails);
    // Archived snapshots must stay archived on a rerun.
    if (details.identityBackfill) {
      continue;
    }
    const did = row.did ?? details.did;
    if (!isDid(did) || (details.did !== undefined && details.did !== did)) {
      quarantine(row, 'Missing or conflicting trustworthy DID');
      continue;
    }
    const group = groups.get(did) ?? [];
    group.push(row);
    groups.set(did, group);
  }

  for (const [did, rows] of groups) {
    // Choose one whole snapshot deterministically. Never sum overlapping counts
    // or splice checkpoints/daily buckets from different snapshots together.
    const [canonical, ...duplicates] = rows.toSorted(
      (a, b) => b.lastAnalyzedAt.getTime() - a.lastAnalyzedAt.getTime() || a.id.localeCompare(b.id),
    );
    for (const row of duplicates) {
      quarantine(row, DUPLICATE_SNAPSHOT_REASON, canonical.id);
    }
    analysisUpdates.push({
      id: canonical.id,
      did,
      updatedAt: canonical.updatedAt,
      profanityDetails: canonical.profanityDetails as Prisma.InputJsonObject,
    });
  }

  const mentionUpdates = mentions.map((row) => {
    // A reply URI identifies the requester. It proves nothing about the target
    // or whether ingestion used the deleted-parent fallback. Do not infer from
    // its linked analysis either: the old handle cache could have been wrong.
    const directAuthor = row.isReply
      ? undefined
      : /^at:\/\/(?<did>did:[^/]+)\/app\.bsky\.feed\.post\/[^/]+$/u.exec(row.postUrl)?.groups?.did;
    const candidate = row.did ?? directAuthor;
    const did = isDid(candidate) ? candidate : null;
    const active = row.status === 'UNPROCESSED' || row.status === 'ANALYZING';
    return {
      id: row.id,
      did,
      updatedAt: row.updatedAt,
      ...(active && !did
        ? {
            status: 'FAILED' as const,
            lastError: 'Missing trustworthy target DID; historical mention quarantined',
          }
        : {}),
    };
  });

  return { analysisUpdates, mentionUpdates };
}
