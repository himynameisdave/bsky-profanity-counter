import { defineConfig } from 'oxlint';
import base from '@himynameisdave/oxlint-config/base';
import vitest from '@himynameisdave/oxlint-config/vitest';

export default defineConfig({
  extends: [base, vitest],
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    // Services are deliberately imported as namespaces (`import * as db`) so call
    // sites read as `db.storeMention(...)` rather than a wall of bare names.
    'import/no-namespace': 'off',
  },
});
