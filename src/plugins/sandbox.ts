import fs from 'fs';
import os from 'os';
import path from 'path';
import semver from 'semver';
import { createRequire } from 'module';
import { PluginManifest, PluginMode } from './manifest';
import { PluginContext } from './context';
import { createHttpBridge, createReadRpcBroker } from './broker';

export function assertSandboxSupported(): void {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      'Plugin sandbox is supported on macOS/Linux only; refusing unsandboxed execution. Core commands remain available. To run a package you trust natively, explicitly relink it with plugin link <directory> --trust.',
    );
  if (!semver.satisfies(process.versions.node, '^22.21.0 || >=24.5.0'))
    throw new Error('Sandboxed plugins require Node 22.21+ or 24.5+; core offckb commands still support Node 20');
}

function runtimeReadPaths(plugin: PluginManifest): string[] {
  const paths = [
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
    '/System',
    '/dev',
    '/etc/ssl',
    '/etc/hosts',
    '/etc/ld.so.cache',
    '/opt/homebrew/Cellar',
    path.dirname(fs.realpathSync(process.execPath)),
    plugin.directory,
  ];
  for (let directory = plugin.directory; directory !== path.dirname(directory); directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules');
    if (fs.existsSync(candidate)) paths.push(fs.realpathSync(candidate));
    if (path.basename(directory) === 'node_modules') paths.push(fs.realpathSync(directory));
  }
  return paths.filter((file) => fs.existsSync(file));
}

export async function preparePluginExecution(
  plugin: PluginManifest,
  contextFile: string | undefined,
  readPaths: string[],
  args: string[],
  port = 7070,
  mode: PluginMode = 'sandbox',
): Promise<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; dispose: () => void }> {
  if (mode === 'sandbox') assertSandboxSupported();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocp-')));
  const cleanup: Array<() => void> = [];
  const dispose = () => {
    for (const close of cleanup.reverse()) close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    // Seatbelt evaluates literal paths. Do not pass /var aliases for /private/var grants.
    if (contextFile) contextFile = fs.realpathSync(contextFile);
    const context = contextFile ? (JSON.parse(fs.readFileSync(contextFile, 'utf8')) as PluginContext) : undefined;
    const read = [...readPaths, root];
    const write = [root];
    const allowedDomains: string[] = [];
    if (context) {
      context.plugin.dataPath = fs.realpathSync(context.plugin.dataPath);
      context.plugin.cachePath = fs.realpathSync(context.plugin.cachePath);
      if (context.devnet.systemScriptsFile)
        context.devnet.systemScriptsFile = fs.realpathSync(context.devnet.systemScriptsFile);
      const sourceRpc = context.devnet.rpcUrl;
      context.devnet.rpcUrl = '';
      context.devnet.proxyUrl = '';
      context.sandbox = { backend: mode === 'sandbox' ? 'os' : 'none', permissions: plugin.permissions };
      read.push(path.dirname(contextFile!), context.plugin.dataPath, context.plugin.cachePath);
      write.push(context.plugin.dataPath, context.plugin.cachePath);
      if (plugin.permissions.includes('project-deployment')) {
        const project = fs.realpathSync(context.cwd);
        const deployment = path.join(project, 'deployment');
        if (fs.existsSync(deployment)) {
          const real = fs.realpathSync(deployment);
          if (!real.startsWith(project + path.sep))
            throw new Error('Project deployment path escapes the project; grant its real path explicitly');
          read.push(real);
        }
      }
      if (plugin.permissions.includes('devnet-read')) {
        const rpc = await createReadRpcBroker(sourceRpc);
        cleanup.push(rpc.close);
        context.devnet.rpcUrl = rpc.url;
        context.devnet.proxyUrl = rpc.url;
        allowedDomains.push(new URL(rpc.url).host);
      }
      if (plugin.permissions.includes('serve')) {
        const http = await createHttpBridge(port);
        cleanup.push(http.close);
        context.sandbox.http = {
          transport: mode === 'sandbox' ? 'proxy-connect-v1' : 'tcp-v1',
          endpoint: http.endpoint,
          token: http.token,
          url: http.url,
        };
        allowedDomains.push(http.endpoint);
      }
      fs.writeFileSync(contextFile!, JSON.stringify(context), { mode: 0o600 });
    }
    // Replace caller variables in both modes. This limits accidental disclosure, not file access
    // by trusted code: an unsandboxed child still has the current user's OS permissions.
    const windows = process.platform === 'win32';
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const env: NodeJS.ProcessEnv = {
      PATH: [
        path.dirname(process.execPath),
        ...(windows
          ? [path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32/WindowsPowerShell/v1.0')]
          : ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']),
      ].join(path.delimiter),
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...(windows
        ? {
            SystemRoot: systemRoot,
            WINDIR: systemRoot,
            ComSpec: path.join(systemRoot, 'System32/cmd.exe'),
            PATHEXT: '.COM;.EXE;.BAT;.CMD',
          }
        : {}),
      ...(contextFile ? { OFFCKB_PLUGIN_CONTEXT: contextFile } : {}),
    };
    const helpOnly = args.length === 1 && (args[0] === '--help' || args[0] === '-h');
    const bindings: Record<string, string> = {
      'devnet.rpcUrl': context?.devnet.rpcUrl || '',
      'plugin.dataPath': context?.plugin.dataPath || root,
      'plugin.cachePath': context?.plugin.cachePath || root,
      cwd: context?.cwd || plugin.directory,
    };
    const bind = (value: string) =>
      value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
        if (key === 'devnet.rpcUrl' && !bindings[key] && !helpOnly) throw new Error('Binary tool requires devnet-read');
        return bindings[key];
      });
    const toolEnv = Object.fromEntries(
      Object.entries(plugin.execution?.env || {}).map(([key, value]) => [key, bind(value)]),
    );
    const command = plugin.runtime === 'binary' ? plugin.entry : process.execPath;
    const commandArgs =
      plugin.runtime === 'binary'
        ? [...(helpOnly ? [] : (plugin.execution?.args || []).map(bind)), ...args]
        : [plugin.entry, ...args];
    if (mode === 'trusted') {
      return { command, args: commandArgs, cwd: plugin.directory, env: { ...env, ...toolEnv }, dispose };
    }
    const externalRequire = createRequire(__filename);
    let runtimeDirectory: string;
    try {
      runtimeDirectory = path.dirname(externalRequire.resolve('@anthropic-ai/sandbox-runtime/package.json'));
    } catch {
      throw new Error(
        'Sandbox runtime is unavailable; reinstall offckb with optional dependencies on a supported Node version. Refusing unsandboxed execution.',
      );
    }
    const runtime = path.join(runtimeDirectory, 'dist/cli.js');
    read.push(...runtimeReadPaths(plugin));
    // Linux executes the runtime's seccomp helper after entering the restricted mount namespace.
    if (process.platform === 'linux') read.push(path.join(runtimeDirectory, 'vendor/seccomp'));
    const literal = (file: string) => ({ path: fs.realpathSync(file), literal: true });
    const policy = path.join(root, 'policy.json');
    fs.writeFileSync(
      policy,
      JSON.stringify({
        filesystem: {
          denyRead: ['/', '/usr/local/etc', '/usr/local/var'],
          allowRead: [...new Set(read)].map(literal),
          allowWrite: write.map(literal),
          denyWrite: ['/tmp/claude', '/private/tmp/claude'],
        },
        network: {
          allowedDomains,
          deniedDomains: [],
          strictAllowlist: true,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
        },
        allowAppleEvents: false,
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        allowNestedUserNamespaces: false,
        allowPty: true,
      }),
      { mode: 0o600 },
    );
    const bootstrap = path.join(root, 'entry.cjs');
    fs.writeFileSync(
      bootstrap,
      // Node snapshots proxy configuration before loading its entry. Start the actual tool only
      // after normalizing the sandbox proxy; the tool and all descendants keep the OS restrictions.
      `process.env.NO_PROXY='';process.env.no_proxy='';for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']){if(process.env[key])process.env[key]=process.env[key].replace('localhost:','127.0.0.1:');}const result=require('node:child_process').spawnSync(process.argv[2],process.argv.slice(3),{cwd:${JSON.stringify(plugin.directory)},env:{...process.env,...${JSON.stringify(toolEnv)}},stdio:'inherit'});if(result.error)console.error(result.error);process.exitCode=result.status??(result.signal?128+require('node:os').constants.signals[result.signal]:1);`,
      { mode: 0o600 },
    );
    env.CLAUDE_CODE_TMPDIR = root;
    env.NODE_USE_ENV_PROXY = '1';
    return {
      command: process.execPath,
      args: [runtime, '--settings', policy, '--', process.execPath, bootstrap, command, ...commandArgs],
      cwd: plugin.directory,
      env,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
