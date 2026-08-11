import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import {
  getTotalProfanityCount,
  formatNumber,
  disconnect,
} from '../../src/services/profile-updater.js';

// Load environment variables
dotenv.config();

// Hits the real database, so it only runs where DATABASE_URL is configured (ie. not CI)
describe.skipIf(!process.env.DATABASE_URL)('Profile Updater Database', () => {
  it('should get total profanity count from database', async () => {
    const totalCount = await getTotalProfanityCount();

    // Should be a non-negative number
    expect(totalCount).toBeGreaterThanOrEqual(0);
    expect(totalCount).toBeTypeOf('number');

    // Should format properly
    const formatted = formatNumber(totalCount);
    expect(formatted).toBeTypeOf('string');

    // Clean up
    await disconnect();
  });
});
