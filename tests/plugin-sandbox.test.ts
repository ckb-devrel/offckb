import { assertSandboxSupported } from '../src/plugins/sandbox';

it('refuses unsupported platforms and Node versions instead of starting a weaker runner', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const node = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(assertSandboxSupported).toThrow(/refusing unsandboxed/);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    for (const version of ['20.19.0', '22.20.0', '24.4.0']) {
      Object.defineProperty(process.versions, 'node', { value: version });
      expect(assertSandboxSupported).toThrow(/require Node/);
    }
    for (const version of ['22.21.0', '24.5.0']) {
      Object.defineProperty(process.versions, 'node', { value: version });
      expect(assertSandboxSupported).not.toThrow();
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.defineProperty(process.versions, 'node', node);
  }
});
