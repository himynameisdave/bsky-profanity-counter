import { vi } from 'vitest';

// Test files share a worker (`isolate: false` in `vitest.config.ts`), so without this a file
// would get the modules, and the mocks baked into them, of whichever file ran before it.
vi.resetModules();
