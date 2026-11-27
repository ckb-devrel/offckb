import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { confirm } from '@inquirer/prompts';
import { logger } from '../util/logger';
import { catalogEntries } from './catalog';
import {
  getNativeBinaryPath,
  linkPlugin,
  listNativeTools,
  listPlugins,
  PluginInfo,
  PluginLinkOptions,
  PluginSource,
  removePlugin,
  unlinkPlugin,
} from './store';
import { PluginManifest, PluginPermission } from './manifest';
import { runPlugin } from './run';
import { installPlugin } from './install';
import { assertSandboxSupported } from './sandbox';

function checkMode(mode: 'sandbox' | 'trusted'): void {
  if (mode === 'sandbox') assertSandboxSupported();
}

function formatPluginRows(
  rows: { command: string; version?: string; status: string; error?: string; detail?: string }[],
): string[] {
  const commandWidth = rows.reduce((width, { command }) => Math.max(width, command.length), 0);
  const versionWidth = rows.reduce((width, { version }) => Math.max(width, version?.length ?? 0), 1);
  return rows.flatMap(({ command, version, status, error, detail }) => {
    const row = `  ${command.padEnd(commandWidth)}  ${(version || '-').padEnd(versionWidth)}  ${status}${error ? ` — ${error}` : ''}`;
    return detail ? [row, `    ${detail}`] : [row];
  });
}

function pluginListRow({ command, version, kind, mode, state, error, source }: PluginInfo) {
  const status = state === 'available' ? '✓ installed' : state;
  return {
    command,
    version,
    status: kind === 'js' ? `${status} (${mode})` : status,
    error,
    detail: !version && source ? `Source: ${source.resolved}` : undefined,
  };
}

const permissionDescriptions: Record<PluginPermission, string> = {
  'devnet-read': 'Query the devnet through a read-only RPC gateway',
  'project-deployment': 'Read deployment/ in the project where you run the plugin',
  serve: 'Serve a web interface on 127.0.0.1 through the host',
};

async function confirmInstallPermissions(
  plugin: PluginManifest,
  source: PluginSource,
  trusted: boolean,
  previousPermissions: readonly PluginPermission[],
): Promise<boolean> {
  process.stderr.write(
    `\n${plugin.command} (${plugin.name}@${plugin.version}) requests permissions:\n` +
      `Source: ${source.resolved}${source.packageLocation ? ` (${source.packageLocation})` : ''}\n` +
      `Mode: ${trusted ? 'trusted — runs with your user permissions, without OS isolation; these grants only control host-provided interfaces' : 'sandbox'}\n\n` +
      plugin.permissions
        .map(
          (permission) =>
            `  ${permission}${previousPermissions.length ? (previousPermissions.includes(permission) ? ' [approved]' : ' [NEW]') : ''}: ${permissionDescriptions[permission]}\n`,
        )
        .join('') +
      '\n',
  );
  try {
    return await confirm(
      { message: 'Allow these permissions and finish installation?', default: false },
      { input: process.stdin, output: process.stderr },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError')
      throw new CommanderError(130, 'plugin.install.cancelled', 'Plugin installation cancelled');
    throw error;
  }
}

function registrationOptions(command: Command): Command {
  return command
    .option('--trust', 'Trust this package to run with your user permissions, without OS isolation', false)
    .option(
      '--allow <permission>',
      'Grant one declared capability (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    )
    .option(
      '--read <path>',
      'Grant an additional read-only path (repeatable)',
      (value, all: string[]) => [...all, value],
      [],
    );
}

/**
 * Shared install path for `offckb plugin install` and the top-level
 * `offckb install <tool>` alias: one installer, one lifecycle, one output
 * shape. Aliased entry points pass default flag values; the interactive
 * consent hook only activates for terminal invocations without explicit
 * grants.
 */
export async function installPluginCommand(
  program: Command,
  reserved: ReadonlySet<string>,
  source: string,
  options: PluginLinkOptions & { allowScripts: boolean },
): Promise<void> {
  const interactive =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.stderr.isTTY &&
    !process.env.CI &&
    !program.opts().json &&
    !logger.isJsonMode() &&
    !options.allow?.length;
  const installed = await installPlugin(source, reserved, {
    ...options,
    ...(interactive
      ? {
          confirmPermissions: (
            plugin: PluginManifest,
            provenance: PluginSource,
            previousPermissions: readonly PluginPermission[] = [],
          ) =>
            confirmInstallPermissions(
              plugin,
              provenance,
              options.trust === true || plugin.kind === 'binary',
              previousPermissions,
            ),
        }
      : {}),
  });
  const plugin = installed.plugin;
  logger.info(`Installed ${plugin.command} (${installed.source.resolved}); run offckb ${plugin.command}`);
  if (plugin.kind === 'binary') {
    logger.warn('Binary tool: runs with your user permissions and is placed on PATH.');
    const stablePath = getNativeBinaryPath(plugin.command);
    if (stablePath) logger.info(`Stable path: ${stablePath} (export with: offckb plugin env)`);
  } else if (options.trust) {
    logger.warn('Trusted mode: this plugin runs with your user permissions, without OS isolation.');
  }
  logger.result({
    command: 'plugin.install',
    plugin: plugin.command,
    directory: plugin.directory,
    kind: plugin.kind,
    permissions: plugin.permissions,
    mode: plugin.kind === 'binary' ? 'trusted' : options.trust ? 'trusted' : 'sandbox',
    source: installed.source,
  });
}

export function coreCommandIndex(program: Command, argv: string[]): number {
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('-')) return index;
    const option = program.options.find((candidate) => candidate.long === token || candidate.short === token);
    if (option?.required && !token.includes('=')) index++;
  }
  return -1;
}

export function registerPluginManagement(program: Command): {
  prepare: (argv: string[]) => { argv: string[]; delegated: () => boolean };
  /** Core command names a plugin command may not claim; for non-`plugin` install entry points. */
  reserved: () => Set<string>;
} {
  program.option(
    '--plugin-port <port>',
    'Loopback web port for a plugin (0 selects a free port)',
    (value) => {
      const port = Number(value);
      if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535)
        throw new InvalidArgumentError('plugin port must be an integer from 0 to 65535');
      return port;
    },
    7070,
  );
  const dynamic = new Set<Command>();
  const reserved = () =>
    new Set([
      'help',
      ...program.commands
        .filter((command) => !dynamic.has(command))
        .flatMap((command) => [command.name(), ...command.aliases()]),
    ]);
  const management = program.command('plugin').description('Link and run local tool plugins (experimental)');
  const link = registrationOptions(
    management.command('link <directory>').description('Register a local plugin with explicit capability grants'),
  ).action((directory: string, options: { allow: string[]; read: string[]; trust: boolean }) => {
    const plugin = linkPlugin(directory, reserved(), options);
    logger.info(`Linked ${plugin.command} (${plugin.name}@${plugin.version})`);
    if (options.trust) logger.warn('Trusted mode: this plugin runs with your user permissions, without OS isolation.');
    logger.result({
      command: 'plugin.link',
      plugin: plugin.command,
      directory: plugin.directory,
      permissions: plugin.permissions,
      mode: options.trust ? 'trusted' : 'sandbox',
    });
  });
  const install = registrationOptions(
    management
      .command('install <source>')
      .description(
        'Install an npm package, github:owner/repo (JavaScript plugins), a catalog tool name, or a local binary tool directory',
      ),
  )
    .option('--allow-scripts', 'Allow npm install/build scripts outside the runtime sandbox (requires --trust)', false)
    .action(async (source: string, options: PluginLinkOptions & { allowScripts: boolean }) => {
      await installPluginCommand(program, reserved(), source, options);
    });
  // Top-level `offckb install <source>` is a pure alias of `plugin install`:
  // same argument surface, same defaults, same lifecycle. The lenient
  // minVersion short-circuit belongs to `offckb create` only, so project
  // creation never force-upgrades a tool.
  const installAlias = registrationOptions(
    program
      .command('install <source>')
      .description('Alias for `offckb plugin install <source>`: install a plugin package or binary tool'),
  )
    .option('--allow-scripts', 'Allow npm install/build scripts outside the runtime sandbox (requires --trust)', false)
    .action(async (source: string, options: PluginLinkOptions & { allowScripts: boolean }) => {
      await installPluginCommand(program, reserved(), source, options);
    });
  management
    .command('list')
    .description('List installed plugins and available catalog tools')
    .action(() => {
      const plugins = listPlugins(reserved(), checkMode);
      const binaries = plugins.filter((plugin) => plugin.kind === 'binary');
      const installedBinaries = new Set(binaries.map((plugin) => plugin.command));
      const catalog = Object.values(catalogEntries()).map((entry) => ({
        command: entry.command,
        name: entry.install.name,
        version: entry.install.version,
        description: entry.install.description,
        installed: installedBinaries.has(entry.command),
      }));
      if (!logger.isJsonMode()) {
        const js = plugins.filter((plugin) => plugin.kind === 'js').map(pluginListRow);
        const jsCommands = new Set(js.map(({ command }) => command));
        const catalogRows = catalog
          .filter(({ installed }) => !installed)
          .map(({ command, version, description }) => {
            const blocked = jsCommands.has(command);
            return {
              command,
              version,
              blocked,
              status: blocked ? 'blocked — command used by a JavaScript plugin' : '✗ available',
              detail: description,
            };
          });
        const binaryRows = formatPluginRows([...binaries.map(pluginListRow), ...catalogRows]);
        logger.info([
          'JavaScript plugins',
          ...(js.length ? formatPluginRows(js) : ['  None installed']),
          '',
          'Binary tools',
          ...(binaryRows.length ? binaryRows : ['  None available']),
          ...(catalogRows.some(({ blocked }) => !blocked)
            ? ['', 'Install a catalog tool with `offckb plugin install <name>`.']
            : []),
        ]);
      }
      logger.result({ command: 'plugin.list', plugins, catalog });
    });
  management
    .command('which <command>')
    .description('Print the stable binary path of an installed binary tool plugin')
    .action((command: string) => {
      const binaryPath = getNativeBinaryPath(command);
      if (!binaryPath) throw new Error(`No installed binary tool named ${command}`);
      // The path is the command's primary output: it must reach stdout even
      // when LOG_LEVEL silences info logs, and must not corrupt the single
      // JSON result line in --json mode.
      if (!logger.isJsonMode()) process.stdout.write(`${binaryPath}\n`);
      logger.result({ command: 'plugin.which', plugin: command, path: binaryPath });
    });
  management
    .command('env')
    .description('Print OFFCKB_TOOL_<COMMAND>=path lines for installed binary tools (eval or source)')
    .action(() => {
      const tools = listNativeTools();
      // Single-quote shell escaping keeps eval safe for any path character.
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      if (!logger.isJsonMode()) {
        for (const tool of tools) process.stdout.write(`${tool.envName}=${quote(tool.path)}\n`);
      }
      logger.result({ command: 'plugin.env', tools });
    });
  management
    .command('remove <command>')
    .description('Uninstall a managed plugin or unlink a local package; keeps data/cache')
    .action((command: string) => {
      removePlugin(command);
      logger.info(`Removed ${command}; data and cache are kept`);
      logger.result({ command: 'plugin.remove', plugin: command });
    });
  management
    .command('unlink <command>')
    .description('Unregister a stopped local plugin; keeps its package and data')
    .action((command: string) => {
      unlinkPlugin(command);
      logger.info(`Unlinked ${command}`);
      logger.result({ command: 'plugin.unlink', plugin: command });
    });

  return {
    reserved,
    prepare(argv) {
      program.setOptionValueWithSource('pluginPort', 7070, 'default');
      // runCli is reusable: an earlier invocation cannot authorize a later link.
      for (const command of [link, install, installAlias]) {
        command.setOptionValueWithSource('allow', [], 'default');
        command.setOptionValueWithSource('read', [], 'default');
        command.setOptionValueWithSource('trust', false, 'default');
      }
      for (const command of [install, installAlias]) {
        command.setOptionValueWithSource('allowScripts', false, 'default');
      }
      for (const command of dynamic) {
        const index = program.commands.indexOf(command);
        // Commander exposes a readonly view of its mutable registration array.
        if (index !== -1) (program.commands as Command[]).splice(index, 1);
      }
      dynamic.clear();
      const index = coreCommandIndex(program, argv);
      const selected = index === -1 ? undefined : argv[index];
      let delegated = false;
      // A broken registry must not break core commands, including help and repair commands.
      let plugins: ReturnType<typeof listPlugins> = [];
      try {
        plugins = listPlugins(reserved(), checkMode);
      } catch (error) {
        if (selected && !reserved().has(selected)) throw error;
      }
      let pluginSelected = false;
      for (const plugin of plugins) {
        if (plugin.state === 'shadowed') continue;
        const command = program
          .command(plugin.command)
          .description(plugin.description || plugin.error || 'Local plugin')
          .helpOption(false)
          .action(async () => {
            if (plugin.state !== 'available') throw new Error(plugin.error);
            const args = argv.slice(index + 1);
            if (args[0] === '--') args.shift();
            delegated = true;
            await runPlugin(plugin.command, args, argv.slice(2, index).includes('--json'), program.opts().pluginPort);
          });
        dynamic.add(command);
        if (plugin.command === selected) pluginSelected = true;
      }
      // Commander parses only the core prefix. The plugin's suffix is kept byte-for-byte above.
      return { argv: pluginSelected ? argv.slice(0, index + 1) : argv, delegated: () => delegated };
    },
  };
}
