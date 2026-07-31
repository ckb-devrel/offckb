import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireEnvLock, isEnvLockHeld, releaseEnvLock } from '../src/fiber/env-lock';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

function lockFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-lock-'));
  tempRoots.push(root);
  return path.join(root, '.offckb-devnet.lock');
}

describe('env lock', () => {
  it('acquires, records the holder, and releases', () => {
    const file = lockFile();
    const handle = acquireEnvLock('test', file);
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.pid).toBe(process.pid);
    expect(isEnvLockHeld(file)).toBe(true);

    handle.release();
    expect(fs.existsSync(file)).toBe(false);
    expect(isEnvLockHeld(file)).toBe(false);
  });

  it('refuses a second acquire while held by a live process', () => {
    const file = lockFile();
    acquireEnvLock('first', file);
    try {
      expect(() => acquireEnvLock('second', file)).toThrow('Another OffCKB process');
    } finally {
      releaseEnvLock(file);
    }
  });

  it('re-acquires a lock whose holder is dead', () => {
    const file = lockFile();
    fs.writeFileSync(file, JSON.stringify({ pid: 99999999, acquiredAt: new Date().toISOString() }));
    const handle = acquireEnvLock('test', file);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.pid).toBe(process.pid);
    handle.release();
  });

  it('does not remove a lock re-acquired by someone else on release', () => {
    const file = lockFile();
    const handle = acquireEnvLock('test', file);
    // Simulate another holder taking over (content replaced).
    fs.writeFileSync(file, JSON.stringify({ pid: 99999999, acquiredAt: 'later' }));
    handle.release();
    expect(fs.existsSync(file)).toBe(true);
    // Clean up the foreign record for the temp-dir removal.
    fs.unlinkSync(file);
  });
});
