import path from 'path';
import { commandLineRunsScript } from '../src/util/daemon';

const POSIX_NODE = '/usr/local/bin/node';
const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';

describe('commandLineRunsScript (posix)', () => {
  const script = '/Users/dev/Library/Application Support/offckb-nodejs/build/index.js';

  it('matches an unquoted ps -o args= line whose paths contain spaces', () => {
    expect(commandLineRunsScript(`${POSIX_NODE} ${script} node --daemon`, script, 'darwin')).toBe(true);
    expect(commandLineRunsScript(`/usr/bin/node ${script}`, script, 'linux')).toBe(true);
    expect(commandLineRunsScript(`nodejs ${script} fiber start --daemon`, script, 'linux')).toBe(true);
  });

  it('matches when the node executable itself also lives under a spaced path', () => {
    const node = '/Users/dev/Library/Application Support/fnm/node';
    expect(commandLineRunsScript(`${node} ${script} node`, script, 'darwin')).toBe(true);
  });

  it('rejects a foreign script, a truncated script and a non-node host', () => {
    expect(commandLineRunsScript(`${POSIX_NODE} ${script}-other node`, script, 'darwin')).toBe(false);
    expect(commandLineRunsScript(`${POSIX_NODE} ${script.slice(0, -3)} node`, script, 'darwin')).toBe(false);
    expect(commandLineRunsScript(`/bin/bash ${script}`, script, 'darwin')).toBe(false);
    expect(commandLineRunsScript(`${POSIX_NODE}`, script, 'darwin')).toBe(false);
    expect(commandLineRunsScript('', script, 'darwin')).toBe(false);
  });

  it('rejects a path that only shares a prefix with the expected script', () => {
    expect(
      commandLineRunsScript(
        `${POSIX_NODE} /Users/dev/Library/Application Support/offckb-nodejs/build/index.js.bak node`,
        script,
        'darwin',
      ),
    ).toBe(false);
  });
});

describe('commandLineRunsScript (windows)', () => {
  const script = 'C:\\Users\\Jane Doe\\AppData\\Local\\offckb-nodejs\\build\\index.js';

  it('matches a Win32_Process CommandLine that quotes arguments containing spaces', () => {
    expect(commandLineRunsScript(`"${WIN_NODE}" "${script}" node --daemon`, script, 'win32')).toBe(true);
    expect(commandLineRunsScript(`"${WIN_NODE}" "${script}"`, script, 'win32')).toBe(true);
  });

  it('matches when only the script needs quoting', () => {
    expect(commandLineRunsScript(`C:\\nodejs\\node.exe "${script}" node`, script, 'win32')).toBe(true);
  });

  it('matches an unquoted Windows command line when neither path has spaces', () => {
    const plain = 'C:\\offckb\\build\\index.js';
    expect(commandLineRunsScript(`C:\\nodejs\\node.exe ${plain} node --daemon`, plain, 'win32')).toBe(true);
  });

  it('rejects a foreign script and a non-node host, case-insensitively for the script', () => {
    expect(commandLineRunsScript(`"${WIN_NODE}" "${script}.bak"`, script, 'win32')).toBe(false);
    expect(commandLineRunsScript(`"C:\\Windows\\System32\\cmd.exe" "${script}"`, script, 'win32')).toBe(false);
    expect(
      commandLineRunsScript(
        `"${WIN_NODE}" "C:\\Users\\Jane Doe\\AppData\\Local\\offckb-nodejs\\build\\INDEX.JS" node`,
        script,
        'win32',
      ),
    ).toBe(true);
  });
});

describe('commandLineRunsScript (posix absolute paths without spaces still work)', () => {
  it('matches a simple absolute path', () => {
    const script = path.posix.join('/opt', 'offckb', 'build', 'index.js');
    expect(commandLineRunsScript(`${POSIX_NODE} ${script} node`, script, 'linux')).toBe(true);
  });
});
