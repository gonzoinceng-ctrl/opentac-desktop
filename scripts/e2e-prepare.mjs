// Thin wrapper: builds the shell, then runs the Playwright e2e suite.
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;
const code = run('node', ['scripts/build.mjs']) || run('npx', ['playwright', 'test', '-c', 'test/e2e/playwright.config.ts']);
process.exit(code);
