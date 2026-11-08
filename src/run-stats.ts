import { appendFileSync } from 'node:fs';

/**
 * What happened during this run, for the job summary and the exit code.
 */
export const stats = {
  startedAt: Date.now(),
  fetched: 0,
  stored: 0,
  answered: 0,
  // Mentions we hit an error on, that a later run retries
  failed: 0,
  gaveUp: 0,
  // Something broke outside any one mention, ie: couldn't log in or fetch
  errors: 0,
};

export function hasFailed(): boolean {
  return stats.failed + stats.gaveUp + stats.errors > 0;
}

/**
 * Appends a table of this run's stats to the GitHub Actions job summary. Does
 * nothing outside of Actions.
 */
export function writeSummary() {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const rows = [
    ['Result', hasFailed() ? '❌ Failed' : '✅ OK'],
    ['Mentions fetched', stats.fetched],
    ['Mentions stored', stats.stored],
    ['Mentions answered', stats.answered],
    ['Mentions failed (retried later)', stats.failed],
    ['Mentions given up on', stats.gaveUp],
    ['Other errors', stats.errors],
    ['Wall time', `${((Date.now() - stats.startedAt) / 1000).toFixed(1)}s`],
  ];

  appendFileSync(
    summaryPath,
    [
      '## 🤖 Run summary',
      '',
      '| | |',
      '| --- | --- |',
      ...rows.map(([label, value]) => `| ${label} | ${value} |`),
      '',
    ].join('\n'),
  );
}
