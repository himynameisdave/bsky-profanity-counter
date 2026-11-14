import { defineConfig } from 'oxlint';
import base from '@himynameisdave/oxlint-config/base';
import vitest from '@himynameisdave/oxlint-config/vitest';

export default defineConfig({
  extends: [base, vitest],
  // The generated Prisma client isn't ours to lint
  ignorePatterns: ['dist', 'node_modules', 'src/generated'],
  rules: {
    // Services are deliberately imported as namespaces (`import * as db`) so call
    // sites read as `db.storeMention(...)` rather than a wall of bare names.
    'import/no-namespace': 'off',
  },
});
