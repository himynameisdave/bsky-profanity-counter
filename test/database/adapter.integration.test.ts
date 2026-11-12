import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import * as db from '../../src/services/database.js';
import { STUCK_MENTION_TIMEOUT_MINUTES } from '../../src/config.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createFixtureClient, testDatabase } from './postgres.js';

dotenv.config({ quiet: true });

const MINUTE_MS = 60 * 1000;

// What Prisma 7's pg driver adapter does differently from Prisma 6's engine, if
// anything: transactions, JSON, timestamps, raw SQL types and shutdown. Explicit
// opt-in as well as DATABASE_URL: it claims the oldest queued mention, so only
// point it at a throwaway database, one suite at a time.
describe.skipIf(!process.env.DATABASE_URL || process.env.PRISMA_ADAPTER_DATABASE_TESTS !== '1')(
  'the Prisma pg adapter in PostgreSQL',
  () => {
    let fixtures: PrismaClient;
    const fixtureId = randomUUID().replaceAll('-', '');
    const did = `did:plc:adapter${fixtureId}`;
    const mentionIds: string[] = [];
    const analysisIds: string[] = [];

    const addMention = async (
      key: string,
      data: { createdAt?: Date; status?: 'ANALYZING' } = {},
    ) => {
      const row = await fixtures.mention.create({
        data: {
          did,
          userHandle: 'adapter.bsky.social',
          postId: key,
          postUrl: `at://${did}/app.bsky.feed.post/${key}`,
          isReply: false,
          ...data,
        },
      });
      mentionIds.push(row.id);
      return row;
    };

    // The service's open connections, which it tags with an application_name
    const botConnections = async () => {
      const [{ count }] = await fixtures.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'profanity.accountant'`;
      return Number(count);
    };

    beforeAll(() => {
      db.init(testDatabase());
      fixtures = createFixtureClient();
    });

    afterAll(async () => {
      await fixtures.mention.deleteMany({ where: { id: { in: mentionIds } } });
      await fixtures.analysis.deleteMany({ where: { id: { in: analysisIds } } });
      await fixtures.$disconnect();
      // A no-op if the shutdown test already closed it
      await db.disconnect();
    });

    it('claims the oldest mention in an interactive transaction, keeping its first attempt time', async () => {
      // Older than anything a real run could have queued
      const mention = await addMention('oldest', {
        createdAt: new Date('1970-01-01T00:00:00.001Z'),
      });

      const first = await db.getUnprocessedMention();
      await fixtures.mention.update({ where: { id: mention.id }, data: { status: 'UNPROCESSED' } });
      const second = await db.getUnprocessedMention();

      expect(first).toMatchObject({ id: mention.id, status: 'ANALYZING', attempts: 1 });
      expect(first?.firstAttemptedAt).toBeInstanceOf(Date);
      expect(second).toMatchObject({ id: mention.id, status: 'ANALYZING', attempts: 2 });
      expect(second?.firstAttemptedAt?.getTime()).toBe(first?.firstAttemptedAt?.getTime());
    });

    it('rolls back an interactive transaction that throws', async () => {
      const mention = await addMention('rollback');

      await expect(
        fixtures.$transaction(async (tx) => {
          await tx.mention.update({ where: { id: mention.id }, data: { lastError: 'half done' } });
          throw new Error('Something went wrong partway');
        }),
      ).rejects.toThrow('Something went wrong partway');

      await expect(
        fixtures.mention.findUniqueOrThrow({ where: { id: mention.id } }),
      ).resolves.toStrictEqual(mention);
    });

    it('commits an array transaction all together, or not at all', async () => {
      const mention = await addMention('handle');
      const analysis = await db.createOrUpdateAnalysis({
        did,
        userHandle: 'adapter.bsky.social',
        totalPosts: 1,
        profanityCount: 0,
        profanityDetails: { wordCounts: {}, topProfanities: [] },
      });
      analysisIds.push(analysis.id);

      await db.refreshTargetHandle(mention.id, did, 'renamed.bsky.social');
      // The mention update fails, so the analysis update must not stick either
      await expect(
        db.refreshTargetHandle('no-such-mention', did, 'never.bsky.social'),
      ).rejects.toMatchObject({ code: 'P2025' });

      await expect(
        fixtures.mention.findUniqueOrThrow({ where: { id: mention.id } }),
      ).resolves.toMatchObject({ userHandle: 'renamed.bsky.social' });
      await expect(db.findAnalysis(did)).resolves.toMatchObject({
        userHandle: 'renamed.bsky.social',
        lastAnalyzedAt: analysis.lastAnalyzedAt,
      });
    });

    it('round-trips JSON and timestamps exactly', async () => {
      const profanityDetails = {
        did,
        wordCounts: { shit: 2_147_483_647, fück: 1, '💩': 3 },
        topProfanities: [{ word: 'shit', count: 2_147_483_647 }],
        days: { '2026-11-12': { posts: 4, wordCounts: { shit: 2 } } },
        checkpoint: { sortTime: 1_762_000_000_123, uris: ['at://x/app.bsky.feed.post/1'] },
        fullCountAt: '2026-11-12T00:00:00.000Z',
      };
      const saved = await db.createOrUpdateAnalysis({
        did: `${did}json`,
        userHandle: 'json.bsky.social',
        totalPosts: 4,
        profanityCount: 6,
        profanityDetails,
      });
      analysisIds.push(saved.id);
      const attemptedAt = new Date('2026-02-03T04:05:06.789Z');
      const mention = await addMention('timestamps');
      await fixtures.mention.update({
        where: { id: mention.id },
        data: { firstAttemptedAt: attemptedAt },
      });

      const found = await db.findAnalysis(`${did}json`);
      const reread = await fixtures.mention.findUniqueOrThrow({ where: { id: mention.id } });

      expect(found?.profanityDetails).toStrictEqual(profanityDetails);
      expect(found?.lastAnalyzedAt.getTime()).toBe(saved.lastAnalyzedAt.getTime());
      expect(reread.firstAttemptedAt?.toISOString()).toBe(attemptedAt.toISOString());
    });

    it('compares timestamps in the database correctly when resetting stuck mentions', async () => {
      const stuck = await addMention('stuck', { status: 'ANALYZING' });
      const busy = await addMention('busy', { status: 'ANALYZING' });
      const longAgo = new Date(Date.now() - (STUCK_MENTION_TIMEOUT_MINUTES + 10) * MINUTE_MS);
      const justNow = new Date(Date.now() - MINUTE_MS);
      await fixtures.$executeRaw`UPDATE "Mention" SET "updatedAt" = ${longAgo} WHERE id = ${stuck.id}`;
      await fixtures.$executeRaw`UPDATE "Mention" SET "updatedAt" = ${justNow} WHERE id = ${busy.id}`;

      await expect(db.resetStuckMentions(STUCK_MENTION_TIMEOUT_MINUTES)).resolves.toBeGreaterThan(
        0,
      );

      const rows = await fixtures.mention.findMany({ where: { id: { in: [stuck.id, busy.id] } } });
      expect(Object.fromEntries(rows.map((row) => [row.postId, row.status]))).toStrictEqual({
        stuck: 'UNPROCESSED',
        busy: 'ANALYZING',
      });
    });

    // getTotalProfanityCount relies on both, and Prisma 6 returned the same
    it('returns bigint and null from raw SQL like Prisma 6 did', async () => {
      const [{ total }] = await fixtures.$queryRaw<[{ total: unknown }]>`
        SELECT SUM(x)::bigint AS total FROM (VALUES (1), (2)) AS v(x)`;
      const [{ none }] = await fixtures.$queryRaw<[{ none: unknown }]>`
        SELECT SUM(x) AS none FROM (VALUES (1)) AS v(x) WHERE false`;

      expect(total).toBe(3n);
      expect(none).toBeNull();
    });

    it('dry-runs the identity backfill in its long transaction without changing anything', async () => {
      const mention = await addMention('backfill');

      const summary = await db.backfillIdentity(false);

      expect(summary.mentions).toBeGreaterThan(0);
      await expect(
        fixtures.mention.findUniqueOrThrow({ where: { id: mention.id } }),
      ).resolves.toStrictEqual(mention);
    });

    // Last, since it closes the service's pool
    it('closes all of its connections on disconnect', async () => {
      await db.getUnprocessedMentionsCount();
      await expect(botConnections()).resolves.toBeGreaterThan(0);

      await db.disconnect();

      // Postgres takes a moment to notice a connection has closed
      await expect.poll(botConnections, { timeout: 5000 }).toBe(0);
    });
  },
);
