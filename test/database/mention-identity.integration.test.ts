import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import type { BskyAgent } from '@atproto/api';
import type { Notification } from '../../src/types.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import * as db from '../../src/services/database.js';
import storeMentions from '../../src/mentions.js';
import { createFixtureClient, testDatabase } from './postgres.js';

vi.mock(import('../../src/services/logger.js'), () => ({
  info: vi.fn<() => void>(),
  success: vi.fn<() => void>(),
  warn: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));

dotenv.config({ quiet: true });

// Explicit opt-in as well as DATABASE_URL: these tests write isolated fixtures.
describe.skipIf(!process.env.DATABASE_URL || process.env.MENTION_IDENTITY_DATABASE_TESTS !== '1')(
  'mention URI identity in PostgreSQL',
  () => {
    let fixtures: PrismaClient;
    const fixtureId = randomUUID().replaceAll('-', '');
    const did = `did:plc:${fixtureId}`;
    const uris: string[] = [];
    const analysisIds: string[] = [];

    const makeMention = (repo: string, key = '3abc'): Parameters<typeof db.storeMention>[0] => {
      const postUrl = `at://${repo}/app.bsky.feed.post/${key}`;
      uris.push(postUrl);
      return { did: repo, userHandle: 'fixture.bsky.social', postId: key, postUrl, isReply: false };
    };

    beforeAll(() => {
      db.init(testDatabase());
      fixtures = createFixtureClient();
    });

    afterAll(async () => {
      await fixtures.mention.deleteMany({ where: { postUrl: { in: uris } } });
      await fixtures.analysis.deleteMany({ where: { id: { in: analysisIds } } });
      await fixtures.$disconnect();
      await db.disconnect();
    });

    it('stores both repositories, keeps both queued, and deduplicates concurrent replays', async () => {
      const inputs = [makeMention(`${did}a`), makeMention(`${did}b`)];
      const notifications: Notification[] = inputs.map((input) => ({
        uri: input.postUrl,
        cid: 'bafycid',
        author: { did: input.did, handle: input.userHandle },
        reason: 'mention',
        record: {},
        isRead: false,
        indexedAt: '2026-01-01T00:00:00.000Z',
        labels: [],
      }));
      const agent = {} as BskyAgent;

      await expect(storeMentions(agent, notifications)).resolves.toBe(true);
      await expect(storeMentions(agent, notifications)).resolves.toBe(true);
      const replays = await Promise.all(
        Array.from({ length: 8 }, (_, index) => db.storeMention(inputs[index % 2])),
      );
      const queued = await fixtures.mention.findMany({
        where: { postUrl: { in: inputs.map((input) => input.postUrl) }, status: 'UNPROCESSED' },
      });

      expect(queued).toHaveLength(2);
      expect(new Set(queued.map((row) => row.id)).size).toBe(2);
      expect(queued.map((row) => row.postUrl).toSorted()).toStrictEqual(
        inputs.map((input) => input.postUrl).toSorted(),
      );
      expect(new Set(replays.map((row) => row.id))).toStrictEqual(
        new Set(queued.map((row) => row.id)),
      );
      expect(queued.every((row) => row.postId === '3abc' && row.attempts === 0)).toBe(true);
    });

    it('arbitrates concurrent first inserts using the URI unique constraint', async () => {
      const input = makeMention(`${did}c`);

      const results = await Promise.all(Array.from({ length: 8 }, () => db.storeMention(input)));

      expect(new Set(results.map((row) => row.id)).size).toBe(1);
      await expect(fixtures.mention.count({ where: { postUrl: input.postUrl } })).resolves.toBe(1);
      // A direct insert without conflict handling must fail at the database constraint.
      await expect(fixtures.mention.create({ data: input })).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it.each(['DONE', 'FAILED'] as const)(
      'leaves the entire %s row and its analysis unchanged on replay',
      async (status) => {
        const input = makeMention(`${did}${status.toLowerCase()}`);
        const analysis = await fixtures.analysis.create({
          data: {
            did: input.did,
            userHandle: input.userHandle,
            totalPosts: 10,
            profanityCount: 2,
            profanityDetails: {},
          },
        });
        analysisIds.push(analysis.id);
        const existing = await fixtures.mention.create({
          data: {
            ...input,
            status,
            attempts: 5,
            firstAttemptedAt: new Date('2026-01-01T00:00:00.000Z'),
            lastError: 'saved processing error',
            analysisId: analysis.id,
            replyPostId: 'saved-reply',
            replyUrl: `at://${did}/app.bsky.feed.post/saved-reply`,
          },
        });

        const replay = {
          ...input,
          did: 'did:plc:changed',
          userHandle: 'changed.bsky.social',
          isReply: true,
        };
        const results = await Promise.all([db.storeMention(replay), db.storeMention(replay)]);

        expect(results).toStrictEqual([existing, existing]);
        await expect(
          fixtures.mention.findUniqueOrThrow({ where: { postUrl: input.postUrl } }),
        ).resolves.toStrictEqual(existing);
        await expect(
          fixtures.analysis.findUniqueOrThrow({ where: { id: analysis.id } }),
        ).resolves.toStrictEqual(analysis);
      },
    );
  },
);
