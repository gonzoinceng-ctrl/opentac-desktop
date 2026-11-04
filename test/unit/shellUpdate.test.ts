import { describe, expect, it } from 'vitest';
import { APP_UPDATES_UNAVAILABLE, createShellUpdater } from '../../src/main/shellUpdate.js';
import { testLogger } from '../helpers/core-fakes.js';

function make(opts: { isPackaged: boolean; hasConfig: boolean }) {
  const notes: string[] = [];
  const { log, out } = testLogger();
  const u = createShellUpdater({
    ui: {
      confirm: async () => false,
      notify: async (n) => {
        notes.push(`${n.title}|${n.message}`);
      },
    },
    log,
    isPackaged: opts.isPackaged,
    hasUpdateConfig: () => opts.hasConfig,
    beforeQuitAndInstall: async () => undefined,
  });
  return { u, notes, out };
}

describe('shell updater without a feed (PKG-2)', () => {
  it('an interactive check in a pack/--dir build says plainly that updates need the release build', async () => {
    const { u, notes, out } = make({ isPackaged: true, hasConfig: false });
    await u.check({ interactive: true });
    expect(notes).toEqual([`${APP_UPDATES_UNAVAILABLE.title}|${APP_UPDATES_UNAVAILABLE.message}`]);
    expect(APP_UPDATES_UNAVAILABLE.message).toContain('installed release build');
    const text = out.join('\n');
    expect(text).toContain('no app-update.yml');
    expect(text).not.toMatch(/\[error\]|\[warn\]/);
  });

  it('an unpackaged interactive check says the same; a background check stays silent', async () => {
    const a = make({ isPackaged: false, hasConfig: false });
    await a.u.check({ interactive: true });
    expect(a.notes).toHaveLength(1);
    const b = make({ isPackaged: true, hasConfig: false });
    await b.u.check({ interactive: false });
    expect(b.notes).toEqual([]);
  });
});
