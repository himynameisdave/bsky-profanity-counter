// Configures the Prisma CLI (`prisma generate`, `prisma db push`, ...). The bot
// doesn't read this: src/services/database.ts gets its URL from loadEnv().
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads `.env` by itself. Variables already set in the shell
// win over the file.
dotenv.config({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Read directly rather than with env('DATABASE_URL'), which throws when it's
    // unset. `prisma generate` doesn't need a database, and the workflows only
    // give the job its URL at the final step. Commands that do connect (ie: `db
    // push`) still fail straight away, saying datasource.url is required.
    url: process.env.DATABASE_URL,
  },
});
