# profanity.accountant

A Bluesky bot that counts how much profanity a user has posted. Node + TypeScript (ESM),
Prisma for the database, pnpm for packages, vitest for tests.

## Before you call anything done

Every change must pass all four of these locally, in this order:

```bash
pnpm format:check   # oxfmt
pnpm lint           # oxlint, --deny-warnings
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
```

CI (`.github/workflows/ci.yml`) runs exactly these on every PR, and a `pre-commit` hook
(`.githooks/pre-commit`, wired up by the `prepare` script) runs the format and lint checks
before any commit lands. Do not bypass the hook with `--no-verify`.

## Linting and formatting

- Lint config lives in `oxlint.config.ts`, extending
  [`@himynameisdave/oxlint-config`](https://www.npmjs.com/package/@himynameisdave/oxlint-config)
  (pinned with `~`, so only patch updates come in automatically).
- Formatting is `oxfmt`'s job, configured in `.oxfmtrc.json`. Never hand-format; run
  `pnpm format`.
- Warnings are errors. If a rule genuinely doesn't fit, silence it narrowly with an
  `// oxlint-disable-next-line <rule>` comment plus a one-line reason, not by turning the
  rule off globally.

## Tests

- New behaviour needs a new test. Bug fixes need a test that fails without the fix.
- Tests live in `test/`, mirroring `src/`.
- Tests must not require a live database or network. Anything that does gets guarded with
  `describe.skipIf(...)` so CI stays green (see `test/profile-updater/db-query.test.ts`).

## Conventions

- Services in `src/services/` are imported as namespaces (`import * as db from ...`) so
  call sites read as `db.storeMention(...)`.
- Type-only imports use the top-level form: `import type { Foo } from '...'`.
- The `@atproto/api` record types are loosely typed. Narrow them with a local type and a
  `typeof` check rather than casting to `any`.
