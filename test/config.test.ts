import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config.js';

const FULL_ENV = {
  BLUESKY_IDENTIFIER: 'test.bot',
  BLUESKY_PASSWORD: 'test-password',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
};

describe(parseEnv, () => {
  it('picks out the Bluesky credentials', () => {
    expect(parseEnv(FULL_ENV)).toStrictEqual({
      bluesky: { identifier: 'test.bot', password: 'test-password' },
    });
  });

  it('names every missing variable at once', () => {
    expect(() => parseEnv({ BLUESKY_IDENTIFIER: 'test.bot' })).toThrow(
      'Missing environment variables: BLUESKY_PASSWORD, DATABASE_URL',
    );
  });

  // Nothing works without the database, so better to say so before logging in
  it('requires DATABASE_URL even though only Prisma reads it', () => {
    expect(() => parseEnv({ ...FULL_ENV, DATABASE_URL: undefined })).toThrow(
      'Missing environment variables: DATABASE_URL',
    );
  });

  it('treats an empty variable as missing', () => {
    expect(() => parseEnv({ ...FULL_ENV, BLUESKY_PASSWORD: '' })).toThrow(
      'Missing environment variables: BLUESKY_PASSWORD',
    );
  });
});
