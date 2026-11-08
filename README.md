<div align="center" margin="0 auto 20px">
   <h1>profanity.accountant</h1>
   <p style="font-style: italic;">
      🤬 A bot for Bluesky which tells you how much profanity a user has posted..
  </p>
   <div>

  </div>
</div>

---

Counting your sins (if profanity was a sin).

## How It Works

1. Tag the bot in a reply to someone's post (or in a post of your own)
2. Within a few minutes, it reads the last year of posts by whoever you replied to (or by you, if it wasn't a reply)
3. It counts every profanity they've used
4. It replies with the total and their top three

### Architecture

Two scheduled GitHub Actions workflows share one Postgres database.

**`scheduled-run.yml`** runs `src/index.ts` every 10 minutes. Each run goes:

1. **Ingest**: fetch unread mention notifications, store each one as a `Mention` row, then mark notifications read up to the last one stored (`src/mentions.ts`)
2. **Queue**: Postgres _is_ the queue. Mentions are claimed one at a time, oldest first, by moving them from `UNPROCESSED` to `ANALYZING` in a transaction (`src/services/database.ts`). A mention whose attempt failed, or whose run died, goes back in the queue once it's been `ANALYZING` for 20 minutes. One that keeps failing for a day is marked `FAILED`
3. **Analyze**: fetch up to a year of the target's posts and count profanity with [`obscenity`](https://github.com/jo3-l/obscenity) and the list in `src/data/badWords.ts`. The result is saved as an `Analysis` and reused for a day (`src/analysis.ts`, `src/services/profanity.ts`)
4. **Reply**: reply in the same thread and mark the mention `DONE` (`src/services/reply.ts`)

**`update-profile.yml`** runs `src/update-profile.ts` every hour. It adds up every `Analysis` and writes the total into the bot's profile description.

The bot's own handle and DID come from the session when it logs in. The limits (how many posts to read, how long to reuse an analysis, and so on) live in `src/config.ts`.

## Setup

You too can run your very own profanity accountant!

### Prerequisites

- Node.js >= `22.18.0`
- `pnpm`
- A Postgres database. For local development, this one matches the URL in `.env.example`:

  ```
  docker run -d --name profanity-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres
  ```

### Installation

1. Clone this repository
2. Install dependencies:

   ```
   pnpm install
   ```

3. Copy `.env.example` to `.env` and fill it in (see [Environment Variables](#environment-variables)):

   ```
   cp .env.example .env
   ```

4. Generate the Prisma client and create the tables:

   ```
   pnpm prisma:generate
   pnpm db:push
   ```

   There are no migration files, so `db:push` is how the schema gets to the database. Run it again whenever `prisma/schema.prisma` changes.

5. Build the project:

   ```
   pnpm build
   ```

6. Run the bot. Each of these does one pass and exits, which is what the workflows run on a schedule:

   ```
   pnpm start            # answer new mentions
   pnpm update-profile   # update the profile description
   ```

### Environment Variables

All three are required. The bot refuses to start, and names whichever are missing, without them.

- `BLUESKY_IDENTIFIER`: The bot account's handle or email
- `BLUESKY_PASSWORD`: An app password for the bot account (its real password works too, but don't)
- `DATABASE_URL`: The Postgres connection string, ie: `postgresql://postgres:postgres@localhost:5432/postgres`

## Deployment

The bot runs on GitHub Actions. To deploy your own:

1. Fork this repository
2. Add these repository secrets:
   - `BLUESKY_IDENTIFIER`
   - `BLUESKY_PASSWORD`
   - `DATABASE_URL`
3. Create the tables in that database by running `pnpm db:push` locally with `DATABASE_URL` pointed at it
4. That's it. The workflows run on their own:
   - **Scheduled Application Run** (`scheduled-run.yml`): every 10 minutes, and on every push to `main`
   - **Update Profile Description** (`update-profile.yml`): every hour

   Both can be run by hand from the Actions tab. Note that GitHub's scheduler is best effort, so runs are often late.

## Contributing

PRs and issues are welcome! Before opening a PR, make sure these all pass (CI runs the same four):

```
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## Inspiration

Shoutout to the [Sheriff of Profanity](https://www.reddit.com/user/profanitycounter/) on Reddit for the inspiration.

## License

MIT
