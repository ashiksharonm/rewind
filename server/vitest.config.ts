import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Every test run gets a throwaway SQLite directory so tests never touch
// server/data (the store opens its database at import time).
export default defineConfig({
  test: {
    // All files share one SQLite directory; run files serially to avoid lock contention.
    fileParallelism: false,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/mcp/**', 'src/agent/live.ts', 'src/index.ts', 'src/cli.ts'], reporter: ['text-summary', 'json-summary'] },
    include: ['test/**/*.test.ts'],
    env: { REWIND_DATA_DIR: mkdtempSync(join(tmpdir(), 'rewind-test-')) },
  },
});
