import { Command, InvalidArgumentError } from 'commander';
import { logger } from '../util/logger';
import { linkPlugin, listPlugins, unlinkPlugin } from './store';
import { runPlugin } from './run';

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
} {
  program.option(
    '--plugin-port <port>',
    'Loopback web port for a sandboxed plugin (0 selects a free port)',
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
  const link = management
    .command('link <directory>')
    .description('Register a local plugin with explicit sandbox capability grants')
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
    )
    .action((directory: string, options: { allow: string[]; read: string[] }) => {
      const plugin = linkPlugin(directory, reserved(), options);
      logger.info(`Linked ${plugin.command} (${plugin.name}@${plugin.version})`);
      logger.result({
        command: 'plugin.link',
        plugin: plugin.command,
        directory: plugin.directory,
        permissions: plugin.permissions,
      });
    });
  management
    .command('list')
    .description('List linked plugins and compatibility diagnostics without executing them')
    .action(() => {
      const plugins = listPlugins(reserved());
      for (const plugin of plugins)
        logger.info(`${plugin.command}: ${plugin.state}${plugin.error ? ` — ${plugin.error}` : ''}`);
      logger.result({ command: 'plugin.list', plugins });
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
    prepare(argv) {
      program.setOptionValueWithSource('pluginPort', 7070, 'default');
      // runCli is reusable: an earlier invocation cannot authorize a later link.
      link.setOptionValueWithSource('allow', [], 'default');
      link.setOptionValueWithSource('read', [], 'default');
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
        plugins = listPlugins(reserved());
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
