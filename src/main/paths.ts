import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Electron-provided inputs for path resolution (injected so this module stays unit-testable). */
export interface PathsInput {
  userData: string;
  logs: string;
  resourcesPath: string;
  appRoot: string;
  isPackaged: boolean;
  arch: 'arm64' | 'x64';
  env?: NodeJS.ProcessEnv;
}

/** Every absolute path the shell uses (03-ARCHITECTURE.md section 2). */
export interface Paths {
  dataDir: string;
  checkoutDir: string;
  envFile: string;
  gevCacheDir: string;
  gevLogsDir: string;
  nodeModulesDir: string;
  viteCacheDir: string;
  stateFile: string;
  stateBackupFile: string;
  npmCacheDir: string;
  logsDir: string;
  mainLog: string;
  serverLog: string;
  nodeBin: string;
  npmCli: string;
  launcherScript: string;
  gitDir: string;
}

/** Resolves the writable data directory, honouring an OPENTAC_DATA_DIR override. */
function resolveDataDir(userData: string, env: NodeJS.ProcessEnv): string {
  const override = env['OPENTAC_DATA_DIR'];
  return override !== undefined && override !== '' ? resolve(override) : userData;
}

/** Resolves the bundled-runtime paths for a packaged or dev layout. */
function resolveRuntimePaths(
  input: PathsInput,
): Pick<Paths, 'nodeBin' | 'npmCli' | 'launcherScript' | 'gitDir'> {
  if (input.isPackaged) {
    const node = join(input.resourcesPath, 'node');
    return {
      nodeBin: join(node, 'bin', 'node'),
      npmCli: join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      launcherScript: join(input.resourcesPath, 'launcher', 'opentac-start.mjs'),
      gitDir: join(input.resourcesPath, 'app.asar.unpacked', 'node_modules', 'dugite', 'git'),
    };
  }
  const node = join(input.appRoot, 'vendor', 'node', `darwin-${input.arch}`);
  return {
    nodeBin: join(node, 'bin', 'node'),
    npmCli: join(node, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    launcherScript: join(input.appRoot, 'resources', 'launcher', 'opentac-start.mjs'),
    gitDir: join(input.appRoot, 'node_modules', 'dugite', 'git'),
  };
}

/** Computes every on-disk path from the injected Electron inputs; pure, touches no disk. */
export function resolvePaths(input: PathsInput): Paths {
  const env = input.env ?? process.env;
  const dataDir = resolveDataDir(input.userData, env);
  const checkoutDir = join(dataDir, 'checkout');
  const nodeModulesDir = join(checkoutDir, 'node_modules');
  return {
    dataDir,
    checkoutDir,
    envFile: join(checkoutDir, '.env'),
    gevCacheDir: join(checkoutDir, '.gev-cache'),
    gevLogsDir: join(checkoutDir, '.gev-logs'),
    nodeModulesDir,
    viteCacheDir: join(nodeModulesDir, '.vite'),
    stateFile: join(dataDir, 'state.json'),
    stateBackupFile: join(dataDir, 'state.json.bak'),
    npmCacheDir: join(dataDir, 'npm-cache'),
    logsDir: input.logs,
    mainLog: join(input.logs, 'main.log'),
    serverLog: join(input.logs, 'server.log'),
    ...resolveRuntimePaths(input),
  };
}

/** Creates the data, npm-cache and logs directories (mkdir -p). */
export function ensureDataDirs(p: Paths): void {
  for (const dir of [p.dataDir, p.npmCacheDir, p.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
