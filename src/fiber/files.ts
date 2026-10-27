import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';

export function readRegularFile(file: string): Buffer {
  if (!fs.statSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  return fs.readFileSync(file);
}

export function readYaml(file: string): unknown {
  const text = readRegularFile(file).toString('utf8');
  try {
    return yaml.load(text);
  } catch {
    // Parser errors include source snippets, potentially private keys.
    throw new Error(`Invalid YAML in ${file}; check its syntax.`);
  }
}

export function writePrivateFile(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
