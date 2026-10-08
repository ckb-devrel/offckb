import { getProcessInfo, verifyDaemonIdentity, PidMetadata } from '../src/util/daemon';

const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

describe('daemon locale and process probing', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalLang = process.env.LANG;
  const originalLcTime = process.env.LC_TIME;
  const originalLcAll = process.env.LC_ALL;
  const originalCliPath = process.env.OFFCKB_CLI_PATH;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      enumerable: true,
      writable: true,
    });
  });

  afterAll(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  beforeEach(() => {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_TIME = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.OFFCKB_CLI_PATH = __filename;
  });

  afterEach(() => {
    if (originalLang !== undefined) {
      process.env.LANG = originalLang;
    } else {
      delete process.env.LANG;
    }
    if (originalLcTime !== undefined) {
      process.env.LC_TIME = originalLcTime;
    } else {
      delete process.env.LC_TIME;
    }
    if (originalLcAll !== undefined) {
      process.env.LC_ALL = originalLcAll;
    } else {
      delete process.env.LC_ALL;
    }
    if (originalCliPath !== undefined) {
      process.env.OFFCKB_CLI_PATH = originalCliPath;
    } else {
      delete process.env.OFFCKB_CLI_PATH;
    }
    mockExecFile.mockReset();
  });

  it('runs ps with LC_ALL=C so getProcessInfo parses start time and leaves parent locale unchanged', async () => {
    const expectedTimeMs = new Date(2026, 7, 13, 12, 36, 26).getTime();

    mockExecFile.mockImplementation((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'object' ? options : {};

      if (file === 'ps') {
        if (args.includes('args=')) {
          cb(null, `"${process.execPath}" "${__filename}"`, '');
          return;
        }
        if (args.includes('lstart=')) {
          // If child env was passed LC_ALL=C, return English date format; otherwise localized date
          if (opts.env?.LC_ALL === 'C') {
            cb(null, 'Wed Aug 13 12:36:26 2026', '');
          } else {
            cb(null, '周三 8月 13 12:36:26 2026', '');
          }
          return;
        }
      }
      cb(new Error(`Unexpected command: ${file}`), '', '');
    });

    const info = await getProcessInfo(12345);

    expect(info).not.toBeNull();
    expect(info?.startTimeMs).toBe(expectedTimeMs);

    // Parent locale must remain unchanged
    expect(process.env.LANG).toBe('zh_CN.UTF-8');
    expect(process.env.LC_TIME).toBe('zh_CN.UTF-8');
    expect(process.env.LC_ALL).toBe('zh_CN.UTF-8');

    // Identity check succeeds when probe returns matching start time
    const metadata: PidMetadata = {
      pid: 12345,
      scriptPath: __filename,
      startedAt: new Date(2026, 7, 13, 12, 36, 26).toISOString(),
    };
    const verified = await verifyDaemonIdentity(12345, metadata);
    expect(verified).toBe(true);
  });

  it('fails daemon identity verification when start time cannot be parsed', async () => {
    mockExecFile.mockImplementation((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;

      if (file === 'ps') {
        if (args.includes('args=')) {
          cb(null, `"${process.execPath}" "${__filename}"`, '');
          return;
        }
        if (args.includes('lstart=')) {
          // Return unparseable localized string regardless of env
          cb(null, '周三 8月 13 12:36:26 2026', '');
          return;
        }
      }
      cb(new Error(`Unexpected command: ${file}`), '', '');
    });

    const info = await getProcessInfo(12345);
    expect(info).not.toBeNull();
    expect(info?.startTimeMs).toBeNull();

    const metadata: PidMetadata = {
      pid: 12345,
      scriptPath: __filename,
      startedAt: new Date(2026, 7, 13, 12, 36, 26).toISOString(),
    };
    const verified = await verifyDaemonIdentity(12345, metadata);
    expect(verified).toBe(false);
  });

  it('fails daemon identity verification when process probe fails', async () => {
    mockExecFile.mockImplementation((file: string, _args: string[], options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(new Error('ps: process not found'), '', '');
    });

    const info = await getProcessInfo(12345);
    expect(info).toEqual({ argv: null, cmdline: null, startTimeMs: null });

    const metadata: PidMetadata = {
      pid: 12345,
      scriptPath: __filename,
      startedAt: new Date(2026, 7, 13, 12, 36, 26).toISOString(),
    };
    const verified = await verifyDaemonIdentity(12345, metadata);
    expect(verified).toBe(false);
  });
});
