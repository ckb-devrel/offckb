import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { CommanderError } from 'commander';
import semver from 'semver';
import { LIFETIME_SIGNALS, LifetimeSignal, signalExitCode } from '../util/child-lifetime';
import { enterGracefulShutdown } from '../util/shutdown';
import { logger } from '../util/logger';
import { readJsonFile, readPluginManifest } from './manifest';
import {
  commitPluginInstallation,
  NativeSource,
  PluginLinkOptions,
  PluginSource,
  pluginNativeDir,
  pluginPackagesPath,
} from './store';
import { signalPluginChild } from './process';
import { catalogEntry } from './catalog';
import { descriptorFromCatalog, installNativeTool, probeBinaryDescriptor } from './native';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface PluginInstallSpec {
  kind: PluginSource['kind'] | 'catalog';
  requested: string;
  spec: string;
  name?: string;
  repository?: string;
  /** catalog: release tag or 'latest'; github: optional ref for binary descriptor probing. */
  ref?: string;
}

/**
 * Deliberately accept registry packages, HTTPS GitHub repositories and
 * first-party catalog names — not arbitrary npm spec protocols. Catalog
 * names are checked first; an npm package that literally shares a catalog
 * name can still be requested with the explicit `npm:` prefix.
 */
export function parsePluginInstallSpec(input: string): PluginInstallSpec {
  if (!input || input.length > 1024 || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Invalid plugin source');
  const catalog = /^([a-z][a-z0-9-]{0,47})(?:@([A-Za-z0-9][A-Za-z0-9._/-]*))?$/.exec(input);
  if (catalog && catalogEntry(catalog[1])) {
    const ref = catalog[2] ?? 'latest';
    if (ref !== 'latest' && (!TAG.test(ref) || ref.includes('..'))) throw new Error(`Invalid release tag: ${ref}`);
    return { kind: 'catalog', requested: input, spec: catalog[1], name: catalog[1], ref };
  }
  const github =
    /^(?:github:|https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?(?:#([A-Za-z0-9][A-Za-z0-9._/-]*))?$/.exec(
      input,
    );
  if (github) {
    const repository = `${github[1]}/${github[2]}`;
    return {
      kind: 'github',
      requested: input,
      repository,
      spec: `git+https://github.com/${repository}.git${github[3] ? `#${github[3]}` : ''}`,
      ref: github[3],
    };
  }
  const spec = input.startsWith('npm:') ? input.slice(4) : input;
  const split = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const name = split === -1 ? spec : spec.slice(0, split);
  const version = split === -1 ? 'latest' : spec.slice(split + 1);
  if (
    name.length > 214 ||
    !PACKAGE_NAME.test(name) ||
    !version ||
    (!semver.validRange(version) && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(version))
  )
    throw new Error('Use an npm package[@version], github:owner/repo[#tag-or-commit], or a catalog tool name');
  return { kind: 'npm', requested: input, spec: `${name}@${version}`, name };
}

/** Run npm's JavaScript entry with Node; npm.cmd is not a native executable on Windows. */
export function resolveNpmCli(): string {
  // npm 10's Git/Dir preparation can run scripts despite ignore-scripts. Ship a fixed CLI;
  // never fall back to an ambient npm whose preparation behavior has not been validated.
  const externalRequire = createRequire(__filename);
  let packageFile: string;
  try {
    packageFile = externalRequire.resolve('npm/package.json');
  } catch {
    throw new Error(
      'The plugin installer requires the bundled npm dependency. Reinstall offckb without omitting optional dependencies on Node 20.17+ (20.x) or 22.9+.',
    );
  }
  const npm = readJsonFile(packageFile) as { version?: string; engines?: { node?: string } };
  if (npm.version !== '11.21.1')
    throw new Error('Unexpected installer npm version; reinstall offckb with its pinned optional dependencies');
  if (!npm.engines?.node || !semver.satisfies(process.versions.node, npm.engines.node))
    throw new Error(
      `Plugin installation requires Node ${npm.engines?.node || '20.17+'}; core commands and linked plugins keep their own requirements`,
    );
  const file = path.join(path.dirname(packageFile), 'bin/npm-cli.js');
  if (!fs.statSync(file).isFile()) throw new Error('Installer npm CLI is missing; reinstall offckb');
  return file;
}

async function runNpm(spec: string, directory: string, allowScripts: boolean): Promise<void> {
  const cli = resolveNpmCli();
  const env = { ...process.env };
  // Propagate policy to npm's nested Git preparation installs too. Remove case variants on Windows.
  for (const key of Object.keys(env)) {
    if (['npm_config_ignore_scripts', 'npm_config_foreground_scripts'].includes(key.toLowerCase())) delete env[key];
  }
  env.npm_config_ignore_scripts = String(!allowScripts);
  env.npm_config_foreground_scripts = 'true';
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`;
  const child = spawn(
    process.execPath,
    [
      cli,
      'install',
      '--global=false',
      '--workspaces=false',
      '--save-exact',
      '--package-lock=true',
      '--audit=false',
      '--fund=false',
      '--omit=dev',
      '--foreground-scripts=true',
      `--ignore-scripts=${!allowScripts}`,
      '--',
      spec,
    ],
    {
      cwd: directory,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // npm and package-script output must never corrupt the host's one JSON result on stdout.
  child.stdout!.pipe(process.stderr, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  let interrupted: LifetimeSignal | undefined;
  let timedOut = false;
  const stop = () => signalPluginChild(child, 'SIGKILL');
  const listeners = LIFETIME_SIGNALS.map((signal) => {
    const listener = () => {
      enterGracefulShutdown();
      interrupted ??= signal;
      stop();
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  process.on('exit', stop);
  const timer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    5 * 60 * 1000,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (interrupted)
      throw new CommanderError(
        signalExitCode(interrupted),
        'plugin.install.cancelled',
        'Plugin installation cancelled',
      );
    if (timedOut) throw new Error('npm plugin installation timed out after five minutes');
    if (code !== 0) throw new Error(`npm installation failed (exit ${code}); the previous plugin is unchanged`);
  } finally {
    clearTimeout(timer);
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
    process.removeListener('exit', stop);
    stop();
  }
}

export async function installPlugin(
  input: string,
  reserved: ReadonlySet<string>,
  options: PluginLinkOptions & { allowScripts?: boolean; trustSource?: string } = {},
): Promise<{ plugin: ReturnType<typeof readPluginManifest>; source: PluginSource | NativeSource }> {
  const source = parsePluginInstallSpec(input);
  if (options.allowScripts && !options.trust)
    throw new Error(
      '--allow-scripts requires --trust: install/build scripts run with your user permissions outside the runtime sandbox',
    );
  if (options.allowScripts)
    logger.warn('Install/build scripts are enabled and run with your user permissions, outside the runtime sandbox.');

  // First-party catalog tools are native binaries managed by offckb.
  if (source.kind === 'catalog') {
    const entry = catalogEntry(source.name!);
    if (!entry) throw new Error(`Unknown catalog tool: ${source.name}`);
    const result = await installNativeTool(descriptorFromCatalog(entry), source.ref ?? 'latest', {
      requested: source.requested,
      sourceKind: 'catalog',
      reserved,
    });
    return {
      plugin: readPluginManifest(pluginNativeDir(result.command)),
      source: { kind: 'catalog', requested: source.requested, resolved: `${entry.name}@${result.version}` },
    };
  }

  // A GitHub repository declaring an offckb-plugin.json binary descriptor is
  // a native tool plugin; otherwise it must be an npm-compatible JS plugin.
  if (source.kind === 'github') {
    const descriptor = await probeBinaryDescriptor(source.repository!, source.ref);
    if (descriptor) {
      const result = await installNativeTool(descriptor, source.ref ?? 'latest', {
        requested: source.requested,
        sourceKind: 'github',
        trustSource: options.trustSource,
        reserved,
      });
      return {
        plugin: readPluginManifest(pluginNativeDir(result.command)),
        source: {
          kind: 'github',
          requested: source.requested,
          resolved: `github:${source.repository}#${result.version}`,
        },
      };
    }
    if (options.trustSource) {
      throw new Error('--trust-source only applies to binary tool sources (an offckb-plugin.json descriptor)');
    }
  }
  const packages = pluginPackagesPath();
  const id = randomUUID();
  // This fresh directory is invisible to discovery until the atomic registry write. Keep its
  // path stable: build/install scripts may legitimately embed their installation directory.
  const staging = path.join(packages, id);
  fs.mkdirSync(staging, { mode: 0o700 });
  let committed = false;
  try {
    fs.writeFileSync(
      path.join(staging, 'package.json'),
      JSON.stringify({ name: 'offckb-plugin-install', version: '0.0.0', private: true }),
    );
    logger.info(`Installing ${source.requested}...`);
    await runNpm(source.spec, staging, options.allowScripts === true);
    const wrapper = readJsonFile(path.join(staging, 'package.json')) as { dependencies?: Record<string, string> };
    const names = Object.keys(wrapper.dependencies || {});
    if (names.length !== 1 || !PACKAGE_NAME.test(names[0]) || (source.name && source.name !== names[0]))
      throw new Error('npm did not install exactly the requested plugin package');
    const relative = path.join('node_modules', names[0]);
    const directory = path.join(staging, relative);
    if (!fs.realpathSync(directory).startsWith(fs.realpathSync(staging) + path.sep))
      throw new Error('Installed plugin directory escapes its managed installation');
    let plugin: ReturnType<typeof readPluginManifest>;
    try {
      plugin = readPluginManifest(directory);
    } catch (error) {
      throw new Error(
        `Installed package is not a usable offckb plugin: ${(error as Error).message}. It must ship a prebuilt entry; GitHub source packages may provide an npm prepare script and require --trust --allow-scripts.`,
      );
    }
    if (plugin.name !== names[0]) throw new Error('Installed package identity does not match its npm dependency');
    const lock = readJsonFile(path.join(staging, 'package-lock.json')) as {
      packages?: Record<string, { resolved?: string }>;
    };
    let resolved = `${plugin.name}@${plugin.version}`;
    if (source.kind === 'github') {
      const commit = /#([a-f0-9]{40})$/i.exec(lock.packages?.[`node_modules/${names[0]}`]?.resolved || '')?.[1];
      if (!commit) throw new Error('npm did not record a fixed GitHub commit in the lockfile');
      resolved = `github:${source.repository}#${commit}`;
    }
    const provenance: PluginSource = { kind: source.kind, requested: source.requested, resolved };
    const registered = commitPluginInstallation(
      directory,
      {
        id,
        name: plugin.name,
        source: provenance,
        allowScripts: options.allowScripts === true,
      },
      reserved,
      options,
      () => {
        committed = true;
      },
    );
    return { plugin: registered, source: provenance };
  } finally {
    if (!committed) fs.rmSync(staging, { recursive: true, force: true });
  }
}
