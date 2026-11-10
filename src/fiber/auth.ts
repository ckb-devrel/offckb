import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { randomBytes } from 'crypto';
import type * as BiscuitApi from '@biscuit-auth/biscuit-wasm' with { 'resolution-mode': 'import' };
import { fiberNodePaths } from './paths';
import { resolveNodeFile, FiberNodeEntry } from './nodes-yml';
import { Settings, readSettings } from '../cfg/setting';
import { readRegularFile, writePrivateFile } from './files';

let biscuitPromise: Promise<typeof BiscuitApi> | undefined;
export function loadBiscuit(): Promise<typeof BiscuitApi> {
  if (!biscuitPromise)
    biscuitPromise = (async () => {
      // Load the official bindings with Node's native WASM API. This avoids
      // experimental WASM module flags and works with the CLI's CommonJS build.
      const candidates = [
        path.join(__dirname, 'biscuit'),
        ...(require.resolve.paths('@biscuit-auth/biscuit-wasm') ?? []).map((dir: string) =>
          path.join(dir, '@biscuit-auth/biscuit-wasm/module'),
        ),
      ];
      const dir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'biscuit_bg.wasm')));
      if (!dir) throw new Error('Biscuit runtime assets are missing; reinstall OffCKB.');
      const module = new WebAssembly.Module(readRegularFile(path.join(dir, 'biscuit_bg.wasm')));
      const nativeImport = (url: string): Promise<Record<string, unknown>> => import(/* webpackIgnore: true */ url);
      const imports: WebAssembly.Imports = {};
      let api: Record<string, unknown> = {};
      const instanceId = randomBytes(8).toString('hex');
      for (const name of new Set(WebAssembly.Module.imports(module).map((entry) => entry.module))) {
        const url = pathToFileURL(path.join(dir, name));
        url.searchParams.set('instance', instanceId);
        const bindings = await nativeImport(url.href);
        if (name === './biscuit_bg.js') api = bindings;
        // WASM's startup banner bypasses our JSON logger. Suppress its console
        // imports; callers report sanitized errors through OffCKB's logger.
        imports[name] = Object.fromEntries(
          Object.entries(bindings).map(([key, value]) => [
            key,
            /^__wbg_(log|debug|info|warn|error)_/.test(key) ? () => {} : value,
          ]),
        ) as WebAssembly.ModuleImports;
      }
      const instance = new WebAssembly.Instance(module, imports);
      (api.__wbg_set_wasm as (exports: WebAssembly.Exports) => void)(instance.exports);
      (instance.exports.__wbindgen_start as () => void)();
      return api as unknown as typeof BiscuitApi;
    })();
  return biscuitPromise;
}

export function biscuitPaths(id: number, settings: Settings = readSettings()) {
  const dir = path.join(fiberNodePaths(id, settings).dir, 'biscuit');
  return { privateKey: path.join(dir, 'private.key'), publicKey: path.join(dir, 'public.key') };
}

export async function prepareBiscuit(node: FiberNodeEntry, settings: Settings) {
  const api = await loadBiscuit();
  const files = biscuitPaths(node.id, settings);
  if (!fs.existsSync(files.privateKey)) {
    const pair = new api.KeyPair();
    const key = pair.getPrivateKey();
    try {
      writePrivateFile(files.privateKey, `ed25519-private/${key.toString()}\n`);
    } finally {
      key.free();
      pair.free();
    }
  }
  const key = api.PrivateKey.fromString(
    readRegularFile(files.privateKey)
      .toString('utf8')
      .trim()
      .replace(/^ed25519-private\//, ''),
  );
  const pair = api.KeyPair.fromPrivateKey(key);
  const pubkey = pair.getPublicKey();
  try {
    const expected = `ed25519/${pubkey.toString()}`;
    if (!fs.existsSync(files.publicKey)) writePrivateFile(files.publicKey, `${expected}\n`);
    else if (readRegularFile(files.publicKey).toString('utf8').trim() !== expected)
      throw new Error(`Fiber node ${node.id}: Biscuit key pair mismatch in ${files.publicKey}.`);
    const tokenFile = resolveNodeFile(node.rpc_token_file, settings);
    if (!fs.existsSync(tokenFile)) {
      const builder = api.Biscuit.builder();
      let consumed = false;
      try {
        builder.addCode('read("node"); read("peers"); write("peers");');
        consumed = true;
        const token = builder.build(key);
        try {
          writePrivateFile(tokenFile, `${token.toBase64()}\n`);
        } finally {
          token.free();
        }
      } finally {
        if (!consumed) builder.free();
      }
    }
  } finally {
    pubkey.free();
    pair.free();
    key.free();
  }
}

export async function validateBiscuitKeyPair(id: number, settings: Settings): Promise<string> {
  const files = biscuitPaths(id, settings);
  const api = await loadBiscuit();
  try {
    const text = readRegularFile(files.privateKey).toString('utf8').trim();
    if (!/^ed25519-private\/[0-9a-f]{64}$/i.test(text)) throw new Error('invalid format');
    const key = api.PrivateKey.fromString(text.split('/')[1]);
    try {
      const pair = api.KeyPair.fromPrivateKey(key);
      try {
        const publicKey = pair.getPublicKey();
        try {
          const expected = `ed25519/${publicKey.toString()}`;
          if (readRegularFile(files.publicKey).toString('utf8').trim() !== expected) throw new Error('mismatch');
          return expected;
        } finally {
          publicKey.free();
        }
      } finally {
        pair.free();
      }
    } finally {
      key.free();
    }
  } catch {
    throw new Error(`Fiber node ${id}: invalid or mismatched Biscuit key files in ${path.dirname(files.privateKey)}.`);
  }
}

export class FiberAuthError extends Error {}
export interface FiberRpcAuth {
  tokenFile: string;
}
export function readRpcToken(auth?: FiberRpcAuth): string | undefined {
  if (!auth) return undefined;
  let token: string;
  try {
    token = readRegularFile(auth.tokenFile).toString('utf8').trim();
  } catch {
    throw new FiberAuthError(`Cannot read RPC token file ${auth.tokenFile}.`);
  }
  if (!token || !/^[A-Za-z0-9_+/=-]+$/.test(token))
    throw new FiberAuthError(`Invalid RPC token file ${auth.tokenFile}.`);
  return token;
}

export async function validateRpcToken(tokenFile: string, publicKey: string) {
  const api = await loadBiscuit();
  try {
    const key = api.PublicKey.fromString(publicKey.replace(/^ed25519\//, ''));
    try {
      const token = api.Biscuit.fromBase64(readRpcToken({ tokenFile })!, key);
      try {
        for (const permission of ['read("node")', 'read("peers")', 'write("peers")']) {
          const authorizer = new api.Authorizer();
          try {
            authorizer.addToken(token);
            authorizer.addCode(`time(${new Date().toISOString()}); allow if ${permission};`);
            authorizer.authorize();
          } finally {
            authorizer.free();
          }
        }
      } finally {
        token.free();
      }
    } finally {
      key.free();
    }
  } catch {
    throw new FiberAuthError(
      `RPC token ${tokenFile} is invalid, expired, or lacks node/peer management permissions for the configured public key.`,
    );
  }
}
