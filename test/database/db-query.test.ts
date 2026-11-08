import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { getTotalProfanityCount, disconnect } from '../../src/services/database.js';

// Load environment variables
dotenv.config({ quiet: true });

// Hits the real database, so it only runs where DATABASE_URL is configured (ie. not CI)
describe.skipIf(!process.env.DATABASE_URL)('Database', () => {
  it('should get total profanity count from database', async () => {
    const totalCount = await getTotalProfanityCount();

    // Should be a non-negative number
    expect(totalCount).toBeGreaterThanOrEqual(0);
    expect(totalCount).toBeTypeOf('number');

    // Clean up
    await disconnect();
  });
});
