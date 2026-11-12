import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share workers instead of each getting a fresh one, which makes the suite
    // about three times faster. `test/setup.ts` gives every file a clean set of modules.
    isolate: false,
    setupFiles: ['./test/setup.ts'],
  },
});
