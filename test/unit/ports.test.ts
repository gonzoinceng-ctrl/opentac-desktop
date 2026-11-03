import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort, isPortFree } from '../../src/main/ports.js';

const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
  );
});

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      open.push(s);
      resolve(s);
    });
  });
}

/** Finds a block of `n` consecutive free ports on 127.0.0.1 by probing from an ephemeral port. */
async function freeBlock(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = await listen(0);
    const start = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    open.splice(open.indexOf(probe), 1);
    let ok = start + n < 65536;
    for (let i = 0; ok && i < n; i += 1) ok = await isPortFree(start + i);
    if (ok) return start;
  }
  throw new Error('could not find a free port block');
}

describe('isPortFree', () => {
  it('is false for a port with a live listener and true once it closes', async () => {
    const server = await listen(0);
    const port = (server.address() as AddressInfo).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((done) => server.close(() => done()));
    open.splice(open.indexOf(server), 1);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('findFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    const start = await freeBlock(3);
    const port = await findFreePort({ preferred: start + 1, rangeStart: start, rangeEnd: start + 2 });
    expect(port).toBe(start + 1);
  });

  it('falls through to the next free range port when preferred is occupied', async () => {
    const start = await freeBlock(3);
    await listen(start);
    const port = await findFreePort({ preferred: start, rangeStart: start, rangeEnd: start + 2 });
    expect(port).toBe(start + 1);
  });

  it('skips occupied range ports and returns the first free one', async () => {
    const start = await freeBlock(3);
    await listen(start);
    await listen(start + 1);
    expect(await findFreePort({ rangeStart: start, rangeEnd: start + 2 })).toBe(start + 2);
  });

  it('tries a preferred port outside the range', async () => {
    const block = await freeBlock(4);
    const port = await findFreePort({ preferred: block + 3, rangeStart: block, rangeEnd: block + 1 });
    expect(port).toBe(block + 3);
  });

  it('rejects with a clear error when the whole range is occupied', async () => {
    const start = await freeBlock(2);
    await listen(start);
    await listen(start + 1);
    await expect(findFreePort({ rangeStart: start, rangeEnd: start + 1 })).rejects.toThrow(
      new RegExp(`No free port found on 127\\.0\\.0\\.1 in range ${start}-${start + 1}`),
    );
  });
});
