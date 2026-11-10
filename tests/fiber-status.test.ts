import fs from 'fs';
import os from 'os';
import path from 'path';
import * as readiness from '../src/devnet/readiness';
import * as daemon from '../src/util/daemon';
import * as rpc from '../src/fiber/rpc';
import { FiberAuthError } from '../src/fiber/auth';
import { newNodeEntry, writeManifest } from '../src/fiber/nodes-yml';
import { writeRuntime } from '../src/fiber/runtime';
import { defaultSettings } from '../src/cfg/setting';
import { fiberNodePaths, nodesYmlPath } from '../src/fiber/paths';
import { fiberNodeAccount } from '../src/fiber/accounts';
import { collectFiberStatus, lockMatches } from '../src/fiber/status';

/**
 * The funding-lock comparison shared by `fiber status` and the manager's
 * startup validation: case-insensitive, all three fields, no partial match.
 */
describe('lockMatches', () => {
  const expected = { codeHash: '0xAbC123', hashType: 'type', args: '0xDEADbeef' };

  it('matches a lock equal up to hex casing', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'TYPE', args: '0xdeadbeef' }, expected)).toBe(true);
  });

  it('rejects a missing lock', () => {
    expect(lockMatches(undefined, expected)).toBe(false);
  });

  it('rejects a differing code hash', () => {
    expect(lockMatches({ code_hash: '0x000000', hash_type: 'type', args: '0xdeadbeef' }, expected)).toBe(false);
  });

  it('rejects a differing hash type', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'data', args: '0xdeadbeef' }, expected)).toBe(false);
  });

  it('rejects differing args', () => {
    expect(lockMatches({ code_hash: '0xabc123', hash_type: 'type', args: '0x1234' }, expected)).toBe(false);
  });
});

it('queries the live startup snapshot after current config and registry edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-status-'));
  const settings = structuredClone(defaultSettings);
  settings.devnet.configPath = path.join(root, 'devnet');
  const paths = fiberNodePaths(1, settings);
  const account = fiberNodeAccount(1);
  fs.mkdirSync(paths.fiberDir, { recursive: true });
  fs.writeFileSync(paths.fiberSkFile, Buffer.from(account.privkey.slice(2), 'hex'));
  jest.spyOn(readiness, 'checkNodeReadiness').mockResolvedValue({ ready: true } as never);
  jest.spyOn(daemon, 'getProcessCommandLine').mockResolvedValue('offckb node --fiber');
  const probe = jest
    .spyOn(rpc, 'fnnNodeInfo')
    .mockResolvedValue({
      version: '0.9.0',
      pubkey: account.pubkey.slice(2),
      default_funding_lock_script: {
        code_hash: account.lockScript.codeHash,
        hash_type: account.lockScript.hashType,
        args: account.lockScript.args,
      },
    } as never);
  try {
    writeRuntime(
      {
        managerPid: process.pid,
        status: 'running',
        startedAt: new Date().toISOString(),
        nodes: [
          {
            id: 1,
            pid: process.pid,
            dir: paths.dir,
            rpcUrl: 'http://127.0.0.1:21714',
            configFile: paths.configFile,
            tokenFile: '/original/token',
            authEnabled: true,
            accountIndex: 3,
            fundingLock: account.lockScript,
            fundingAddress: account.address,
            customConfig: 'no',
          },
        ],
      },
      settings,
    );
    // Even invalid on-disk configuration must not replace the running binding.
    fs.writeFileSync(nodesYmlPath(settings), 'nodes: [secret-value');
    let report = await collectFiberStatus(settings);
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:21714', 2000, { tokenFile: '/original/token' });
    expect(report.nodes[0]).toMatchObject({ status: 'running', accountIndex: 3, customConfig: 'no' });
    expect(report.nodes[0].reasons.join(' ')).not.toContain('secret-value');
    const edited = {
      ...newNodeEntry(1, { type: 'builtin', index: 12 }),
      initialized: true,
      rpc_token_file: '/edited/token',
    };
    writeManifest(
      { fnn: { binary_path: process.execPath, template_file: '/template.yml', version: null }, nodes: [edited] },
      settings,
    );
    report = await collectFiberStatus(settings);
    expect(report.nodes[0]).toMatchObject({
      status: 'running',
      accountIndex: 3,
      customConfig: 'no',
      tokenFile: '/original/token',
    });
    probe.mockRejectedValue(new FiberAuthError('authentication failed: token is missing or insufficient'));
    report = await collectFiberStatus(settings);
    expect(report.nodes[0].status).toBe('unknown');
    expect(report.nodes[0].reasons.join(' ')).toContain('authentication');
  } finally {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
