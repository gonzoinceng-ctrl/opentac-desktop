import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // With OPENTAC_E2E_APP set (the engine mirror's gate) only the packaged-app smoke runs; the
  // fixture suite needs the unpackaged build and the dev-only fakes.
  testMatch: (process.env['OPENTAC_E2E_APP'] ?? '') !== '' ? 'gate.spec.ts' : 'app.spec.ts',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
});
