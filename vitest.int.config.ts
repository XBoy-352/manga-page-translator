import { defineConfig } from 'vitest/config';

// Integration tests (tests/int/**) download real models from MODEL_REGISTRY
// and are run locally via `npm run test:int`, never in CI (spec §11).
// passWithNoTests keeps the script green until slice s4 adds the first
// integration test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/int/**/*.test.ts'],
    passWithNoTests: true,
  },
});
