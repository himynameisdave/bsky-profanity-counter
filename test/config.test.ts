import { describe, it, expect } from 'vitest';
import { parseDatabaseUrl, parseEnv } from '../src/config.js';

const DATABASE_URL = 'postgresql://postgres:s3cret-pa55@localhost:5432/postgres';

const FULL_ENV = {
  BLUESKY_IDENTIFIER: 'test.bot',
  BLUESKY_PASSWORD: 'test-password',
  DATABASE_URL,
};

describe(parseEnv, () => {
  it('picks out the Bluesky credentials and the database config', () => {
    expect(parseEnv(FULL_ENV)).toStrictEqual({
      bluesky: { identifier: 'test.bot', password: 'test-password' },
      database: { url: DATABASE_URL },
    });
  });

  it('names every missing variable at once', () => {
    expect(() => parseEnv({ BLUESKY_IDENTIFIER: 'test.bot' })).toThrow(
      'Missing environment variables: BLUESKY_PASSWORD, DATABASE_URL',
    );
  });

  // Nothing works without the database, so better to say so before logging in
  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({ ...FULL_ENV, DATABASE_URL: undefined })).toThrow(
      'Missing environment variables: DATABASE_URL',
    );
  });

  it('treats an empty variable as missing', () => {
    expect(() => parseEnv({ ...FULL_ENV, BLUESKY_PASSWORD: '' })).toThrow(
      'Missing environment variables: BLUESKY_PASSWORD',
    );
  });

  it('rejects a DATABASE_URL that is set but unusable, before anything connects', () => {
    expect(() => parseEnv({ ...FULL_ENV, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      'DATABASE_URL must start with postgresql:// or postgres://',
    );
  });
});

describe(parseDatabaseUrl, () => {
  it('keeps the whole URL, query string and all, for the driver', () => {
    const url = `${DATABASE_URL}?sslmode=verify-full&application_name=fork`;

    expect(parseDatabaseUrl(url)).toStrictEqual({ url });
  });

  it.each(['verify-full', 'disable'])(
    'lets another machine through once the URL says sslmode=%s',
    (mode) => {
      const url = `postgresql://root:s3cret-pa55@db.example.com/db?sslmode=${mode}`;

      expect(parseDatabaseUrl(url)).toStrictEqual({ url });
    },
  );

  it('accepts the postgres:// spelling too', () => {
    expect(parseDatabaseUrl('postgres://localhost/db')).toStrictEqual({
      url: 'postgres://localhost/db',
    });
  });

  // Prisma 6 read this itself; the pg driver ignores it
  it('picks out the schema parameter', () => {
    expect(parseDatabaseUrl(`${DATABASE_URL}?schema=bot_data`)).toStrictEqual({
      url: `${DATABASE_URL}?schema=bot_data`,
      schema: 'bot_data',
    });
  });

  it('refuses a schema it could not safely quote', () => {
    expect(() => parseDatabaseUrl(`${DATABASE_URL}?schema=a%22%3B%20drop`)).toThrow(
      'schema parameter that is not a plain identifier',
    );
  });

  it.each([
    ['not a URL at all', 's3cret-pa55 at localhost', 'DATABASE_URL is not a valid URL'],
    ['another database', 'mysql://root:s3cret-pa55@localhost/db', 'must start with postgresql://'],
    [
      'another machine without sslmode',
      'postgresql://root:s3cret-pa55@db.example.com/db',
      'has no sslmode',
    ],
  ])('rejects %s without repeating the URL', (_, url, message) => {
    expect(() => parseDatabaseUrl(url)).toThrow(message);
    expect(() => parseDatabaseUrl(url)).not.toThrow(/s3cret-pa55|localhost/u);
  });
});
