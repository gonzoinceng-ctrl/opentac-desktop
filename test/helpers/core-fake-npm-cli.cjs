// Stand-in for npm-cli.js used by the update-flow integration test. Runs as
// `node core-fake-npm-cli.cjs ci ...` inside the checkout: creates node_modules and records the
// lockfile it "installed", so tests can see which lockfile an install belonged to.
const fs = require('node:fs');
if (!fs.existsSync('package-lock.json')) {
  console.error('npm error code ENOLOCK');
  process.exit(1);
}
fs.rmSync('node_modules', { recursive: true, force: true });
// Failure hook: when <TMPDIR>/fail-npm-once exists, behave like an `npm ci` that died after
// wiping node_modules (the flag is consumed so the next call succeeds).
const failFlag = require('node:path').join(process.env.TMPDIR || '', 'fail-npm-once');
if (process.env.TMPDIR && fs.existsSync(failFlag)) {
  fs.rmSync(failFlag, { force: true });
  console.error('npm error code E500');
  process.exit(1);
}
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/.fake-install', fs.readFileSync('package-lock.json'));
// Like a real node_modules, ignore everything inside it (the fixture repo has no .gitignore entry for it).
fs.writeFileSync('node_modules/.gitignore', '*\n');
console.log('added 1 package in 0s');
