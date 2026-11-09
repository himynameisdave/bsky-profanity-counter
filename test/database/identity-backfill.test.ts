import { describe, expect, it } from 'vitest';
import type { Analysis, Mention, Prisma } from '@prisma/client';
import { planIdentityBackfill } from '../../src/services/identity-backfill.js';

const snapshot = (id: string, did?: string): Analysis => ({
  id,
  did: null,
  userHandle: 'reassigned.example.com',
  totalPosts: 10,
  profanityCount: 7,
  profanityDetails: {
    ...(did ? { did } : {}),
    wordCounts: { shit: 7 },
    days: { '2026-07-15': { postCount: 10, wordCounts: { shit: 7 } } },
    checkpoint: { sortTime: 123, uris: ['at://post'] },
    fullCountAt: '2026-07-15T00:00:00Z',
  },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastAnalyzedAt: new Date(0),
});
const mention = (
  id: string,
  isReply: boolean,
  status: Mention['status'] = 'UNPROCESSED',
): Mention => ({
  id,
  did: null,
  userHandle: 'reassigned.example.com',
  postId: id,
  postUrl: `at://did:plc:requester/app.bsky.feed.post/${id}`,
  isReply,
  status,
  attempts: 4,
  firstAttemptedAt: new Date(0),
  lastError: 'Earlier failure',
  replyPostId: 'reply',
  replyUrl: 'at://reply',
  analysisId: 'older',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const applyPlan = (analyses: Analysis[], mentions: Mention[]) => {
  const plan = planIdentityBackfill(analyses, mentions);
  return {
    analyses: analyses.map((row) => ({
      ...row,
      ...plan.analysisUpdates.find(({ id }) => id === row.id),
    })) as Analysis[],
    mentions: mentions.map((row) => ({
      ...row,
      ...plan.mentionUpdates.find(({ id }) => id === row.id),
    })),
    plan,
  };
};

describe('historical identity backfill', () => {
  it('only trusts stored DIDs, never the present owner of an old handle', () => {
    const result = applyPlan([snapshot('proven', 'did:plc:original'), snapshot('unknown')], []);
    expect(result.analyses[0].did).toBe('did:plc:original');
    expect(result.analyses[1].did).toBeNull();
    expect(result.analyses[1].profanityDetails).toMatchObject({
      identityBackfill: { reason: 'Missing or conflicting trustworthy DID' },
    });
  });

  it('keeps one whole newest snapshot for duplicate DIDs without summing or losing relationships', () => {
    const older = snapshot('older', 'did:plc:original');
    const newer = {
      ...snapshot('newer', 'did:plc:original'),
      userHandle: 'renamed.example.com',
      lastAnalyzedAt: new Date(10),
      totalPosts: 12,
      profanityCount: 9,
    };
    const linked = mention('history', true, 'DONE');
    const result = applyPlan([older, newer], [linked]);
    expect(result.analyses.filter((row) => row.did)).toStrictEqual([
      { ...newer, did: 'did:plc:original' },
    ]);
    expect(result.analyses[0]).toMatchObject({
      did: null,
      totalPosts: 10,
      profanityCount: 7,
      profanityDetails: { identityBackfill: { canonicalAnalysisId: 'newer' } },
    });
    expect(result.mentions).toStrictEqual([linked]);
    expect(planIdentityBackfill(result.analyses, result.mentions).analysisUpdates).toStrictEqual([
      {
        id: 'newer',
        did: 'did:plc:original',
        updatedAt: newer.updatedAt,
        profanityDetails: newer.profanityDetails,
      },
    ]);
  });

  it('uses deterministic ID ordering for tied snapshots', () => {
    const rows = [snapshot('b', 'did:plc:one'), snapshot('a', 'did:plc:one')];
    expect(
      applyPlan(rows, [])
        .analyses.filter((row) => row.did)
        .map((row) => row.id),
    ).toStrictEqual(['a']);
  });

  it('recovers direct authors from DID URIs but never mistakes a reply requester for the target', () => {
    const direct = mention('direct', false);
    const reply = mention('reply', true);
    const done = mention('done', true, 'DONE');
    const failed = mention('failed', true, 'FAILED');
    const result = applyPlan(
      [snapshot('older', 'did:plc:somebody-else')],
      [direct, reply, done, failed],
    );
    expect(result.mentions[0]).toStrictEqual({ ...direct, did: 'did:plc:requester' });
    expect(result.mentions[1]).toStrictEqual({
      ...reply,
      status: 'FAILED',
      lastError: 'Missing trustworthy target DID; historical mention quarantined',
    });
    expect(result.mentions.slice(2)).toStrictEqual([done, failed]);
    for (const row of result.mentions) {
      expect(row).toMatchObject({ attempts: 4, analysisId: 'older', replyUrl: 'at://reply' });
    }
  });

  it('quarantines malformed provenance and conflicting identity without resolving anything', () => {
    const broken = { ...snapshot('broken'), profanityDetails: { did: 'old.example.com' } };
    const conflict = { ...snapshot('conflict', 'did:plc:one'), did: 'did:plc:two' };
    const badUri = {
      ...mention('bad-uri', false),
      postUrl: 'at://old.example.com/app.bsky.feed.post/post',
    };
    const result = applyPlan([broken, conflict], [badUri]);
    expect(result.analyses.every((row) => row.did === null)).toBe(true);
    expect(result.mentions[0]).toMatchObject({ did: null, status: 'FAILED' });
  });

  it('retains already-proven parent identities and all incremental data', () => {
    const original = { ...snapshot('proven', 'did:plc:target'), did: 'did:plc:target' };
    const reply = { ...mention('reply', true), did: 'did:plc:target' };
    const result = applyPlan([original], [reply]);
    expect(result.analyses).toStrictEqual([original]);
    expect(result.mentions).toStrictEqual([reply]);
    expect(result.analyses[0].profanityDetails as Prisma.JsonObject).toStrictEqual(
      original.profanityDetails,
    );
  });
});
