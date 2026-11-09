import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import * as db from '../../src/services/database.js';
import { DUPLICATE_SNAPSHOT_REASON } from '../../src/services/identity-backfill.js';

dotenv.config({ quiet: true });

// Explicit opt-in as well as DATABASE_URL: these tests write fixtures and check
// a total over the whole table, so only ever point them at a throwaway database.
describe.skipIf(!process.env.DATABASE_URL || process.env.PROFILE_TOTAL_DATABASE_TESTS !== '1')(
  'profile total in PostgreSQL',
  () => {
    const fixtures = new PrismaClient();
    const fixtureId = randomUUID().replaceAll('-', '');
    const handle = (name: string) => `${name}-${fixtureId}.bsky.social`;
    const analysisIds: string[] = [];

    const addAnalysis = async (
      profanityCount: number,
      userHandle: string,
      did: string | null,
      archivedBecause?: string,
    ) => {
      const row = await fixtures.analysis.create({
        data: {
          did,
          userHandle,
          totalPosts: 1,
          profanityCount,
          profanityDetails: {
            wordCounts: {},
            topProfanities: [],
            ...(archivedBecause ? { identityBackfill: { reason: archivedBecause } } : {}),
          },
        },
      });
      analysisIds.push(row.id);
    };

    afterAll(async () => {
      await fixtures.analysis.deleteMany({ where: { id: { in: analysisIds } } });
      await fixtures.$disconnect();
      await db.disconnect();
    });

    it('counts archived analyses once, and never the bot', async () => {
      const bot = { excludeDid: `did:plc:bot${fixtureId}`, excludeHandle: handle('bot') };
      const before = await db.getTotalProfanityCount(bot);
      const beforeEveryone = await db.getTotalProfanityCount();

      await addAnalysis(1, handle('current'), `did:plc:current${fixtureId}`);
      await addAnalysis(2, handle('archived'), null, 'Missing or conflicting trustworthy DID');
      await addAnalysis(4, handle('duplicate'), null, DUPLICATE_SNAPSHOT_REASON);
      // Analyzed again since, so the row above already counts them
      await addAnalysis(8, handle('current'), null, 'Missing or conflicting trustworthy DID');
      await addAnalysis(16, handle('bot-old-name'), bot.excludeDid);
      await addAnalysis(32, bot.excludeHandle, null, 'Missing or conflicting trustworthy DID');

      expect((await db.getTotalProfanityCount(bot)) - before).toBe(1 + 2);
      expect((await db.getTotalProfanityCount()) - beforeEveryone).toBe(1 + 2 + 16 + 32);
    });
  },
);
