import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import * as db from '../../src/services/database.js';
import { parseDatabaseUrl } from '../../src/config.js';
import type { DatabaseConfig } from '../../src/config.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createFixtureClient, quoteIdentifier, testDatabase } from './postgres.js';

dotenv.config({ quiet: true });

const withSchema = (schema: string): DatabaseConfig => {
  const url = new URL(testDatabase().url);
  url.searchParams.set('schema', schema);
  return parseDatabaseUrl(url.href);
};

const analysisIn = (schema: string) => `${quoteIdentifier(schema)}."Analysis"`;

// The pg driver ignores the URL's `schema`, so the adapter qualifies generated
// queries with it, and raw SQL has to name the same schema itself. Here the
// role's search_path puts a competing schema, with different data, ahead of
// public, so anything left to search_path reads the wrong table. Part of the
// adapter suite's opt-in: it changes a role setting (and puts it back), so only
// point it at a throwaway database, one suite at a time.
describe.skipIf(!process.env.DATABASE_URL || process.env.PRISMA_ADAPTER_DATABASE_TESTS !== '1')(
  'the URL schema versus search_path in PostgreSQL',
  () => {
    const fixtureId = randomUUID().replaceAll('-', '').slice(0, 12);
    const competing = `competing_${fixtureId}`;
    const custom = `custom_${fixtureId}`;
    const publicIds: string[] = [];
    let admin: PrismaClient;
    let alterRole = '';
    // What to put back: the old setting, null if there wasn't one, or undefined
    // if we never changed it
    let previousSearchPath: string | null | undefined;
    let createdPublicAnalysis = false;

    const roleSearchPath = async () => {
      const rows = await admin.$queryRaw<{ setting: string }[]>`
        SELECT s.setting FROM pg_db_role_setting d, unnest(d.setconfig) AS s(setting)
        WHERE d.setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND s.setting LIKE 'search_path=%'`;
      return rows[0]?.setting.slice('search_path='.length) ?? null;
    };

    const addRow = (schema: string, id: string, profanityCount: number) =>
      admin.$executeRawUnsafe(
        `INSERT INTO ${analysisIn(schema)} (id, did, "userHandle", "totalPosts", "profanityCount", "profanityDetails", "updatedAt")
         VALUES ($1, $2, $3, 1, $4, '{}', now())`,
        id,
        `did:plc:${id}`,
        `${id}.test`,
        profanityCount,
      );

    beforeAll(async () => {
      admin = createFixtureClient();
      const [{ role, database }] = await admin.$queryRaw<[{ role: string; database: string }]>`
        SELECT current_user AS role, current_database() AS database`;
      alterRole = `ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(database)}`;

      // The bot's tables, copied into schemas of their own, each with its own data
      const source = analysisIn(testDatabase().schema ?? 'public');
      const [{ exists }] = await admin.$queryRaw<[{ exists: boolean }]>`
        SELECT to_regclass('public."Analysis"') IS NOT NULL AS exists`;
      if (!exists) {
        await admin.$executeRawUnsafe(
          `CREATE TABLE public."Analysis" (LIKE ${source} INCLUDING ALL)`,
        );
        createdPublicAnalysis = true;
      }
      for (const schema of [competing, custom]) {
        // Each depends on the schema the statement before it made
        // oxlint-disable-next-line no-await-in-loop
        await admin.$executeRawUnsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        // oxlint-disable-next-line no-await-in-loop
        await admin.$executeRawUnsafe(
          `CREATE TABLE ${analysisIn(schema)} (LIKE ${source} INCLUDING ALL)`,
        );
      }
      await addRow(competing, `competing${fixtureId}`, 1_000_000);
      await addRow(custom, `custom${fixtureId}`, 30);

      previousSearchPath = await roleSearchPath();
      await admin.$executeRawUnsafe(
        `${alterRole} SET search_path TO ${quoteIdentifier(competing)}, public`,
      );
    });

    afterAll(async () => {
      try {
        if (previousSearchPath !== undefined) {
          await admin.$executeRawUnsafe(
            previousSearchPath === null
              ? `${alterRole} RESET search_path`
              : `${alterRole} SET search_path TO ${previousSearchPath}`,
          );
          // Fail loudly rather than leave the role's setting changed
          if ((await roleSearchPath()) !== previousSearchPath) {
            throw new Error(`Couldn't restore the role's search_path (${previousSearchPath})`);
          }
        }
      } finally {
        await db.disconnect();
        await admin.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(competing)} CASCADE`,
        );
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(custom)} CASCADE`);
        await (createdPublicAnalysis
          ? admin.$executeRawUnsafe('DROP TABLE public."Analysis"')
          : admin.$executeRawUnsafe(
              'DELETE FROM public."Analysis" WHERE id = ANY($1::text[])',
              publicIds,
            ));
        await admin.$disconnect();
      }
    });

    it('sends unqualified SQL on a new connection to the competing schema', async () => {
      const probe = createFixtureClient();
      try {
        const [{ total }] = await probe.$queryRaw<[{ total: bigint }]>`
          SELECT SUM("profanityCount") AS total FROM "Analysis"`;
        expect(total).toBe(1_000_000n);
      } finally {
        await probe.$disconnect();
      }
    });

    it('keeps generated queries and the raw total in public when the URL says schema=public', async () => {
      db.init(withSchema('public'));
      try {
        const did = `did:plc:public${fixtureId}`;
        const before = await db.getTotalProfanityCount();

        const saved = await db.createOrUpdateAnalysis({
          did,
          userHandle: `public${fixtureId}.test`,
          totalPosts: 1,
          profanityCount: 7,
          profanityDetails: { wordCounts: {}, topProfanities: [] },
        });
        publicIds.push(saved.id);

        await expect(db.findAnalysis(did)).resolves.toMatchObject({ id: saved.id });
        expect((await db.getTotalProfanityCount()) - before).toBe(7);
        const [{ inPublic, inCompeting }] = await admin.$queryRawUnsafe<
          [{ inPublic: bigint; inCompeting: bigint }]
        >(
          `SELECT (SELECT count(*) FROM public."Analysis" WHERE did = $1) AS "inPublic",
                  (SELECT count(*) FROM ${analysisIn(competing)} WHERE did = $1) AS "inCompeting"`,
          did,
        );
        expect({ inPublic, inCompeting }).toStrictEqual({ inPublic: 1n, inCompeting: 0n });
      } finally {
        await db.disconnect();
      }
    });

    it('keeps generated queries and the raw total in a custom schema from the URL', async () => {
      db.init(withSchema(custom));
      try {
        const did = `did:plc:inside${fixtureId}`;
        await expect(db.getTotalProfanityCount()).resolves.toBe(30);

        await db.createOrUpdateAnalysis({
          did,
          userHandle: `inside${fixtureId}.test`,
          totalPosts: 1,
          profanityCount: 3,
          profanityDetails: { wordCounts: {}, topProfanities: [] },
        });

        await expect(db.findAnalysis(did)).resolves.toMatchObject({ profanityCount: 3 });
        await expect(db.getTotalProfanityCount()).resolves.toBe(33);
      } finally {
        await db.disconnect();
      }
    });
  },
);
