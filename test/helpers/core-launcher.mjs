// Launcher for the update-flow integration test: honours OPENTAC_FAIL_START_ONCE the way the real
// resources/launcher/opentac-start.mjs does, otherwise behaves exactly like the shared fake launcher.
if (process.env.OPENTAC_FAIL_START_ONCE === '1') {
  console.error('[OpenTac] Simulated start failure (OPENTAC_FAIL_START_ONCE).');
  process.exit(97);
}
await import('../fixtures/fake-launcher.mjs');
