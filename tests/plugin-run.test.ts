import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPlugin } from '../src/plugins/run';
import { linkPlugin, unlinkPlugin } from '../src/plugins/store';

const mockCreateContext = jest.fn();
jest.mock('../src/plugins/context', () => ({
  createPluginContext: (...args: unknown[]) => mockCreateContext(...args),
}));
jest.mock('../src/util/shutdown', () => ({ enterGracefulShutdown: jest.fn() }));

let root: string;
let originalHome: string | undefined;
let originalOutput: string | undefined;
let output: string;
let contextFile: string;
let dispose: jest.Mock;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb runner '));
  originalHome = process.env.OFFCKB_PLUGIN_HOME;
  originalOutput = process.env.OFFCKB_TEST_OUTPUT;
  output = path.join(root, 'result.json');
  process.env.OFFCKB_PLUGIN_HOME = path.join(root, 'home');
  process.env.OFFCKB_TEST_OUTPUT = output;
  contextFile = path.join(root, 'context.json');
  dispose = jest.fn(() => fs.rmSync(contextFile, { force: true }));
  mockCreateContext.mockReset().mockImplementation(() => {
    fs.writeFileSync(contextFile, JSON.stringify({ apiVersion: 1 }));
    return { file: contextFile, dispose };
  });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'runner-test',
      version: '1.0.0',
      offckb: { apiVersion: 1, command: 'runner', entry: 'entry.cjs' },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'entry.cjs'),
    `
    const fs = require('fs');
    const args = process.argv.slice(2);
    let descendant;
    if (args.includes('descendant')) descendant = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.env.OFFCKB_TEST_OUTPUT + ".desc", "ready"); setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    fs.writeFileSync(process.env.OFFCKB_TEST_OUTPUT, JSON.stringify({ args, context: process.env.OFFCKB_PLUGIN_CONTEXT || null, cwd: process.cwd(), descendant: descendant?.pid }));
    if (args.includes('wait')) {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => process.exit(0));
    } else if (args.includes('fail')) process.exit(7);
  `,
  );
  linkPlugin(root, new Set());
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.OFFCKB_PLUGIN_HOME;
  else process.env.OFFCKB_PLUGIN_HOME = originalHome;
  if (originalOutput === undefined) delete process.env.OFFCKB_TEST_OUTPUT;
  else process.env.OFFCKB_TEST_OUTPUT = originalOutput;
  process.exitCode = undefined;
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('runs a real Node child with cwd, exact argv and context, then removes its lease and temporary files', async () => {
  await runPlugin('runner', ['a b', '--json', '--', '$literal'], true);
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toMatchObject({
    args: ['a b', '--json', '--', '$literal'],
    cwd: process.cwd(),
    context: contextFile,
  });
  expect(process.exitCode).toBe(0);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(contextFile)).toBe(false);
  expect(() => unlinkPlugin('runner')).not.toThrow();
});

it('delegates help without exporting context and removes an inherited context variable', async () => {
  const previous = process.env.OFFCKB_PLUGIN_CONTEXT;
  process.env.OFFCKB_PLUGIN_CONTEXT = '/stale/context.json';
  try {
    await runPlugin('runner', ['--help'], false);
  } finally {
    if (previous === undefined) delete process.env.OFFCKB_PLUGIN_CONTEXT;
    else process.env.OFFCKB_PLUGIN_CONTEXT = previous;
  }
  expect(JSON.parse(fs.readFileSync(output, 'utf8')).context).toBeNull();
  expect(mockCreateContext).not.toHaveBeenCalled();
});

it('preserves nonzero exit codes and cleans up after context preparation fails', async () => {
  await runPlugin('runner', ['fail'], false);
  expect(process.exitCode).toBe(7);
  mockCreateContext.mockImplementationOnce(() => {
    throw new Error('bad settings');
  });
  await expect(runPlugin('runner', [], false)).rejects.toThrow('bad settings');
  expect(() => unlinkPlugin('runner')).not.toThrow();
});

it('forwards a captured shutdown signal to its owned process group and waits for cleanup', async () => {
  if (process.platform === 'win32') return; // Signal and taskkill behavior needs a Windows host.
  const listeners = new Map<string, () => void>();
  const originalOn = process.on.bind(process);
  jest.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(event)) {
      listeners.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);
  const running = runPlugin('runner', ['wait', 'descendant'], false);
  const start = Date.now();
  while ((!fs.existsSync(output) || !fs.existsSync(output + '.desc')) && Date.now() - start < 3000)
    await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    expect(fs.existsSync(output)).toBe(true);
    expect(() => unlinkPlugin('runner')).toThrow('running');
  } finally {
    listeners.get('SIGTERM')!();
    await running;
  }
  expect(process.exitCode).toBe(143);
  expect(dispose).toHaveBeenCalledTimes(1);
  const descendant = JSON.parse(fs.readFileSync(output, 'utf8')).descendant;
  const deadline = Date.now() + 1000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(descendant, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
  expect(() => unlinkPlugin('runner')).not.toThrow();
});
