import { createServer } from 'node:net';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_RANGE_START = 4173;
const DEFAULT_RANGE_END = 4273;

/** Options for findFreePort; the range is inclusive on both ends. */
export interface FindFreePortOptions {
  host?: string;
  preferred?: number;
  rangeStart?: number;
  rangeEnd?: number;
}

/** Resolves true when a throwaway server can listen on host:port, false otherwise. */
export function isPortFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolvePort(false));
    server.listen(port, host, () => {
      server.close(() => resolvePort(true));
    });
  });
}

/** Finds a free port: the preferred one first (if given), then sequentially through the range. */
export async function findFreePort(opts: FindFreePortOptions = {}): Promise<number> {
  const host = opts.host ?? DEFAULT_HOST;
  const start = opts.rangeStart ?? DEFAULT_RANGE_START;
  const end = opts.rangeEnd ?? DEFAULT_RANGE_END;
  if (opts.preferred !== undefined && (await isPortFree(opts.preferred, host))) {
    return opts.preferred;
  }
  for (let port = start; port <= end; port += 1) {
    if (port === opts.preferred) continue;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free port found on ${host} in range ${start}-${end}`);
}
