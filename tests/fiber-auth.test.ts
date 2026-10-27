import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import { defaultSettings, Settings } from '../src/cfg/setting';
import { newNodeEntry, resolveNodeFile } from '../src/fiber/nodes-yml';
import { biscuitPaths, FiberAuthError, loadBiscuit, prepareBiscuit, validateRpcToken } from '../src/fiber/auth';
import { fnnNodeInfo, fnnListPeers, fnnConnectPeer } from '../src/fiber/rpc';

let root: string;
let settings: Settings;
let server: http.Server | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-fiber-auth-'));
  settings = structuredClone(defaultSettings);
  settings.devnet.configPath = path.join(root, 'devnet');
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});
it('creates tokens accepted by the configured key with node and independent peer read/write grants', async () => {
  const node = newNodeEntry(1);
  await prepareBiscuit(node, settings);
  const key = fs.readFileSync(biscuitPaths(1, settings).publicKey, 'utf8').trim();
  const file = resolveNodeFile(node.rpc_token_file, settings);
  await expect(validateRpcToken(file, key)).resolves.toBeUndefined();
  const api = await loadBiscuit();
  const pubkey = api.PublicKey.fromString(key.split('/')[1]);
  const token = api.Biscuit.fromBase64(fs.readFileSync(file, 'utf8').trim(), pubkey);
  const authorizer = new api.Authorizer();
  try {
    authorizer.addToken(token);
    authorizer.addCode('allow if write("channels");');
    expect(() => authorizer.authorize()).toThrow();
  } finally {
    authorizer.free();
    token.free();
    pubkey.free();
  }
  await prepareBiscuit(newNodeEntry(2), settings);
  const other = fs.readFileSync(biscuitPaths(2, settings).publicKey, 'utf8').trim();
  await expect(validateRpcToken(file, other)).rejects.toBeInstanceOf(FiberAuthError);
});
it('rejects insufficient and expired permissions without exposing token text', async () => {
  const api = await loadBiscuit();
  const pair = new api.KeyPair();
  const privateKey = pair.getPrivateKey();
  const publicKey = pair.getPublicKey();
  const file = path.join(root, 'token');
  try {
    for (const code of [
      'read("node");',
      'read("node"); read("peers"); write("peers"); check if time($t), $t < 2000-01-01T00:00:00Z;',
    ]) {
      const builder = api.Biscuit.builder();
      builder.addCode(code);
      const token = builder.build(privateKey);
      const text = token.toBase64();
      token.free();
      fs.writeFileSync(file, text);
      try {
        await validateRpcToken(file, `ed25519/${publicKey.toString()}`);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(FiberAuthError);
        expect((error as Error).message).not.toContain(text);
      }
    }
  } finally {
    publicKey.free();
    privateKey.free();
    pair.free();
  }
});
it('uses each token file for all management RPCs and reloads replacement credentials', async () => {
  const file = path.join(root, 'token');
  fs.writeFileSync(file, 'first-token');
  const received: string[] = [];
  server = http.createServer((req, res) => {
    received.push(String(req.headers.authorization));
    let data = '';
    req.on('data', (part) => {
      data += part;
    });
    req.on('end', () => {
      const method = JSON.parse(data).method;
      res.end(
        JSON.stringify({
          result: method === 'node_info' ? { version: '0.9.0' } : method === 'list_peers' ? { peers: [] } : null,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fnnNodeInfo(url, 1000, { tokenFile: file });
  fs.writeFileSync(file, 'replacement-token');
  await fnnListPeers(url, 1000, { tokenFile: file });
  await fnnConnectPeer(url, '/ip4/127.0.0.1/tcp/1', true, 1000, { tokenFile: file });
  expect(received).toEqual(['Bearer first-token', 'Bearer replacement-token', 'Bearer replacement-token']);
  fs.unlinkSync(file);
  await expect(fnnNodeInfo(url, 1000, { tokenFile: file })).rejects.toBeInstanceOf(FiberAuthError);
});
it('recognizes non-JSON HTTP authentication failures', async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end('permission denied');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await expect(fnnNodeInfo(url)).rejects.toBeInstanceOf(FiberAuthError);
});
