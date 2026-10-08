import {
  findStaleMiners,
  isMinerCommandFor,
  minerArgs,
  parsePosixProcessList,
  parseWindowsProcessList,
  ProcessEntry,
} from '../src/devnet/stale-miner';

const CONFIG = '/Users/dev/Library/Application Support/offckb-nodejs/devnet';
const CKB = '/Users/dev/Library/Application Support/offckb-nodejs/bins/0.204.0/ckb';

function entry(pid: number, ppid: number, name: string, args: string): ProcessEntry {
  return { pid, ppid, name, args };
}

describe('isMinerCommandFor', () => {
  it('matches the exact miner command for the devnet dir, including paths with spaces', () => {
    expect(isMinerCommandFor(`${CKB} miner -C ${CONFIG}`, CONFIG)).toBe(true);
    expect(isMinerCommandFor(`ckb miner -C ${CONFIG}`, CONFIG)).toBe(true);
  });

  it('matches Windows quoted command lines', () => {
    // Node quotes an argument only when it contains whitespace or quotes.
    const spaced = 'C:\\Users\\Jane Doe\\AppData\\Local\\offckb-nodejs\\Data\\devnet';
    expect(isMinerCommandFor(`"C:\\Program Files\\offckb\\ckb.exe" miner -C "${spaced}"`, spaced)).toBe(true);
    const plain = 'C:\\Users\\dev\\AppData\\Local\\offckb-nodejs\\Data\\devnet';
    expect(isMinerCommandFor(`C:\\offckb\\ckb.exe miner -C ${plain}`, plain)).toBe(true);
  });

  it('rejects other commands, other dirs and other executables', () => {
    expect(isMinerCommandFor(`${CKB} run -C ${CONFIG}`, CONFIG)).toBe(false);
    expect(isMinerCommandFor(`${CKB} miner -C ${CONFIG}-other`, CONFIG)).toBe(false);
    expect(isMinerCommandFor(`${CKB} miner -C /other/devnet`, CONFIG)).toBe(false);
    expect(isMinerCommandFor(`/usr/bin/not-ckb miner -C ${CONFIG}`, CONFIG)).toBe(false);
    expect(isMinerCommandFor(`/bin/sh -c ckb miner -C ${CONFIG}`, CONFIG)).toBe(false);
    expect(isMinerCommandFor(`vim ${CONFIG}`, CONFIG)).toBe(false);
  });
});

describe('findStaleMiners', () => {
  const minerArgs = `${CKB} miner -C ${CONFIG}`;

  it('selects miners whose offckb parent is gone (re-parented to launchd/init/a subreaper)', () => {
    const entries = [
      entry(1, 0, '/sbin/launchd', '/sbin/launchd'),
      entry(52, 1, 'systemd', '/lib/systemd/systemd --user'),
      entry(100, 1, CKB, minerArgs),
      entry(101, 52, 'ckb', minerArgs),
    ];
    expect(findStaleMiners(entries, CONFIG, 999).map((e) => e.pid)).toEqual([100, 101]);
  });

  it('selects miners whose parent PID no longer exists (Windows keeps the dead parent PID)', () => {
    const entries = [entry(200, 4242, 'ckb.exe', minerArgs)];
    expect(findStaleMiners(entries, CONFIG, 999).map((e) => e.pid)).toEqual([200]);
  });

  it('leaves miners of a live offckb (Node) process alone', () => {
    const entries = [
      entry(300, 1, '/usr/local/bin/node', '/usr/local/bin/node /usr/local/bin/offckb node'),
      entry(301, 300, 'ckb', minerArgs),
      entry(310, 1, 'node.exe', 'node.exe offckb node'),
      entry(311, 310, 'ckb.exe', minerArgs),
    ];
    expect(findStaleMiners(entries, CONFIG, 999)).toEqual([]);
  });

  it('never selects processes for another devnet dir or that are not miners', () => {
    const entries = [
      entry(400, 1, 'ckb', `${CKB} miner -C /other/devnet`),
      entry(401, 1, 'ckb', `${CKB} run -C ${CONFIG}`),
      entry(402, 1, 'bash', `bash -c sleep 1000`),
    ];
    expect(findStaleMiners(entries, CONFIG, 999)).toEqual([]);
  });
});

describe('minerArgs', () => {
  it('is what the matcher recognizes, so the spawn site and the reaper cannot drift apart', () => {
    expect(isMinerCommandFor([CKB, ...minerArgs(CONFIG)].join(' '), CONFIG)).toBe(true);
    expect(isMinerCommandFor([CKB, ...minerArgs(CONFIG), '--extra'].join(' '), CONFIG)).toBe(false);
  });
});

describe('parsePosixProcessList', () => {
  it('joins the args and comm passes by PID, keeping spaces in both', () => {
    const argsOut = [
      '    1     0 /sbin/launchd',
      `  812     1 ${CKB} miner -C ${CONFIG}`,
      '  900   850 /usr/local/bin/node /usr/local/bin/offckb node',
      '',
    ].join('\n');
    const commOut = ['    1 /sbin/launchd', `  812 ${CKB}`, '  900 /usr/local/bin/node', ''].join('\n');
    expect(parsePosixProcessList(argsOut, commOut)).toEqual([
      { pid: 1, ppid: 0, name: '/sbin/launchd', args: '/sbin/launchd' },
      { pid: 812, ppid: 1, name: CKB, args: `${CKB} miner -C ${CONFIG}` },
      { pid: 900, ppid: 850, name: '/usr/local/bin/node', args: '/usr/local/bin/node /usr/local/bin/offckb node' },
    ]);
    expect(findStaleMiners(parsePosixProcessList(argsOut, commOut), CONFIG, 999).map((e) => e.pid)).toEqual([812]);
  });
});

describe('parseWindowsProcessList', () => {
  const config = 'C:\\Users\\dev\\AppData\\Local\\offckb-nodejs\\Data\\devnet';

  it('parses CIM JSON rows and finds a miner whose parent PID is gone', () => {
    const json = JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, Name: 'System', CommandLine: null },
      {
        ProcessId: 5120,
        ParentProcessId: 4242,
        Name: 'ckb.exe',
        CommandLine: `"C:\\Program Files\\offckb\\ckb.exe" miner -C ${config}`,
      },
    ]);
    const entries = parseWindowsProcessList(json)!;
    expect(entries).toEqual([
      { pid: 4, ppid: 0, name: 'System', args: '' },
      {
        pid: 5120,
        ppid: 4242,
        name: 'ckb.exe',
        args: `"C:\\Program Files\\offckb\\ckb.exe" miner -C ${config}`,
      },
    ]);
    expect(findStaleMiners(entries, config, 999).map((e) => e.pid)).toEqual([5120]);
  });

  it('accepts the bare object ConvertTo-Json emits for a single row', () => {
    const json = JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'ckb.exe', CommandLine: 'ckb.exe' });
    expect(parseWindowsProcessList(json)).toEqual([{ pid: 7, ppid: 1, name: 'ckb.exe', args: 'ckb.exe' }]);
  });

  it('returns null for malformed output', () => {
    expect(parseWindowsProcessList('not json')).toBeNull();
    expect(parseWindowsProcessList('null')).toBeNull();
  });
});
