import os from 'os';
import { logger } from '../src/util/logger';
import { Request } from '../src/util/request';

jest.mock('child_process', () => ({ execSync: jest.fn() }));

const cpuFeatures = jest.fn();
jest.mock('cpu-features', () => cpuFeatures, { virtual: true });

describe('CKB binary installation', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => jest.restoreAllMocks());

  it('skips CPU detection for both Windows package names', async () => {
    const platform = jest.spyOn(os, 'platform').mockReturnValue('win32');
    const send = jest.spyOn(Request, 'send').mockRejectedValue(new Error('stop download'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    // Keep these dependencies shared across the fresh installer module.
    jest.doMock('os', () => ({ __esModule: true, default: os }));
    jest.doMock('../src/util/request', () => ({ Request }));
    jest.doMock('../src/util/logger', () => ({ logger }));
    const installer = require('../src/node/install');

    expect(installer.buildDownloadUrl('0.208.0')).toContain('ckb_v0.208.0_x86_64-pc-windows-msvc.zip');
    await expect(installer.downloadCKBBinaryAndUnzip('0.208.0')).rejects.toThrow('stop download');
    expect(cpuFeatures).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    platform.mockRestore();
    send.mockRestore();
    error.mockRestore();
  });

  it('reports an unavailable optional module at info level and caches the portable fallback', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.doMock('../src/util/logger', () => ({ logger }));
    jest.doMock(
      'cpu-features',
      () => {
        throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
      },
      { virtual: true },
    );
    const { buildDownloadUrl } = require('../src/node/install');
    const options = { os: 'unknown-linux-gnu', arch: 'x86_64', ext: 'tar.gz' };
    expect(buildDownloadUrl('0.208.0', options)).toContain('linux-gnu-portable.tar.gz');
    expect(buildDownloadUrl('0.208.0', options)).toContain('linux-gnu-portable.tar.gz');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('CPU feature detection unavailable, using portable binary');
    expect(warn).not.toHaveBeenCalled();
  });

  it('includes unexpected detection errors in a warning', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.doMock('../src/util/logger', () => ({ logger }));
    jest.doMock(
      'cpu-features',
      () => () => {
        throw new Error('native load failed');
      },
      { virtual: true },
    );
    const { buildDownloadUrl } = require('../src/node/install');
    expect(buildDownloadUrl('0.208.0', { os: 'unknown-linux-gnu', arch: 'x86_64', ext: 'tar.gz' })).toContain(
      '-portable.tar.gz',
    );
    expect(warn).toHaveBeenCalledWith('Failed to detect CPU features, using portable binary:', 'native load failed');
  });

  it('uses the optimized build when all required CPU features are available', () => {
    jest.doMock(
      'cpu-features',
      () => () => ({ arch: 'x86', flags: { avx2: true, sse4_2: true, bmi2: true, pclmulqdq: true } }),
      { virtual: true },
    );
    const { buildDownloadUrl } = require('../src/node/install');
    expect(buildDownloadUrl('0.208.0', { os: 'unknown-linux-gnu', arch: 'x86_64', ext: 'tar.gz' })).toContain(
      'linux-gnu.tar.gz',
    );
  });

  it('captures version probe stderr and still parses successful output', () => {
    const { execSync } = require('child_process');
    const { getVersionFromBinary } = require('../src/node/install');
    const probe = execSync as jest.MockedFunction<typeof execSync>;
    probe.mockReturnValueOnce('ckb 0.208.0' as never).mockImplementationOnce(() => {
      throw new Error('missing binary');
    });
    expect(getVersionFromBinary('/missing/ckb')).toBe('0.208.0');
    expect(probe).toHaveBeenCalledWith(expect.any(String), { encoding: 'utf-8', stdio: 'pipe' });
    expect(getVersionFromBinary('/missing/ckb')).toBeNull();
  });
});
