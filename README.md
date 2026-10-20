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

1. The bot runs on a schedule (every 10 minutes via GitHub Actions)
2. It checks for new mentions in replies
3. When mentioned, it analyzes the post history of the author of the post being replied to
4. It counts all profanities used by that author
5. It replies with a summary of the profanity count and the most commonly used profanity

## Setup

You too can run your very own profanity accountant!

### Prerequisites

- Node.js >= `22.18.0`
- `pnpm`

### Installation

1. Clone this repository
2. Install dependencies:

   ```
   pnpm install
   ```

3. Copy `.env.example` to `.env` and fill in your Bluesky credentials:

   ```
   cp .env.example .env
   ```

4. Build the project:

   ```
   pnpm build
   ```

5. Run the bot:

   ```
   pnpm start
   ```

### Environment Variables

- `BLUESKY_IDENTIFIER`: Your Bluesky handle or email
- `BLUESKY_PASSWORD`: Your Bluesky password or app password

## Deployment

This bot is designed to run on GitHub Actions. The workflow is configured to run every 10 minutes.

To deploy:

1. Fork this repository
2. Add your Bluesky credentials as repository secrets:
   - `BLUESKY_IDENTIFIER`
   - `BLUESKY_PASSWORD`
3. The GitHub Actions workflow will automatically run the bot on schedule

## Contributing

PRs and issues are welcome!

## Inspiration

Shoutout to the [Sheriff of Profanity](https://www.reddit.com/user/profanitycounter/) on Reddit for the inspiration.

## License

MIT
