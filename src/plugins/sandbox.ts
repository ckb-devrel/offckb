import fs from 'fs';
import os from 'os';
import path from 'path';
import semver from 'semver';
import { createRequire } from 'module';
import { PluginManifest } from './manifest';
import { PluginContext } from './context';
import { createHttpBridge, createReadRpcBroker } from './broker';

export function assertSandboxSupported(): void {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Plugin sandbox is supported on macOS/Linux only; refusing unsandboxed execution');
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

export async function preparePluginSandbox(
  plugin: PluginManifest,
  contextFile: string | undefined,
  readPaths: string[],
  args: string[],
  port = 7070,
): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv; dispose: () => void }> {
  assertSandboxSupported();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ocp-')));
  const cleanup: Array<() => void> = [];
  const dispose = () => {
    for (const close of cleanup.reverse()) close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
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
    // Seatbelt evaluates literal paths. Do not pass /var aliases for /private/var grants.
    if (contextFile) contextFile = fs.realpathSync(contextFile);
    const context = contextFile ? (JSON.parse(fs.readFileSync(contextFile, 'utf8')) as PluginContext) : undefined;
    const read = [...runtimeReadPaths(plugin), ...readPaths, root];
    // Linux executes the runtime's seccomp helper after entering the restricted mount namespace.
    if (process.platform === 'linux') read.push(path.join(runtimeDirectory, 'vendor/seccomp'));
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
      context.sandbox = { backend: 'os', permissions: plugin.permissions };
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
          transport: 'proxy-connect-v1',
          endpoint: http.endpoint,
          token: http.token,
          url: http.url,
        };
        allowedDomains.push(http.endpoint);
      }
      fs.writeFileSync(contextFile!, JSON.stringify(context), { mode: 0o600 });
    }
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
      }),
      { mode: 0o600 },
    );
    const bootstrap = path.join(root, 'entry.cjs');
    fs.writeFileSync(
      bootstrap,
      // Node snapshots proxy configuration before loading its entry. Start the actual tool only
      // after normalizing the sandbox proxy; the tool and all descendants keep the OS restrictions.
      `process.env.NO_PROXY='';process.env.no_proxy='';for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']){if(process.env[key])process.env[key]=process.env[key].replace('localhost:','127.0.0.1:');}const result=require('node:child_process').spawnSync(process.execPath,process.argv.slice(2),{cwd:${JSON.stringify(plugin.directory)},env:process.env,stdio:'inherit'});if(result.error)console.error(result.error);process.exitCode=result.status??(result.signal?128+require('node:os').constants.signals[result.signal]:1);`,
      { mode: 0o600 },
    );
    // Retain only basic presentation/tool lookup variables, never caller credentials or preload hooks.
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
      LANG: 'en_US.UTF-8',
      TMPDIR: root,
      CLAUDE_CODE_TMPDIR: root,
      NODE_USE_ENV_PROXY: '1',
      ...(contextFile ? { OFFCKB_PLUGIN_CONTEXT: contextFile } : {}),
    };
    return {
      command: process.execPath,
      args: [runtime, '--settings', policy, '--', process.execPath, bootstrap, plugin.entry, ...args],
      env,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
