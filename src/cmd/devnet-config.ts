import { readSettings } from '../cfg/setting';
import { logger } from '../util/logger';
import { createDevnetConfigEditor } from '../node/devnet-config-editor';
import { runDevnetConfigTui } from '../tui/devnet-config-tui';

export interface DevnetConfigOptions {
  set?: string[];
}

export interface ParsedSetItem {
  key: string;
  value: string;
}

export function parseSetItem(item: string): ParsedSetItem {
  const separator = item.indexOf('=');
  if (separator <= 0 || separator === item.length - 1) {
    throw new Error(`Invalid --set item '${item}'. Use key=value format.`);
  }

  const key = item.slice(0, separator).trim();
  const value = item.slice(separator + 1).trim();
  if (!key || !value) {
    throw new Error(`Invalid --set item '${item}'. Key and value must not be empty.`);
  }

  return { key, value };
}

export function applySetItems(editor: ReturnType<typeof createDevnetConfigEditor>, items: string[]): ParsedSetItem[] {
  const parsedItems = items.map(parseSetItem);
  for (const parsedItem of parsedItems) {
    editor.setFieldValue(parsedItem.key, parsedItem.value);
  }
  editor.save();
  return parsedItems;
}

export async function devnetConfig(options: DevnetConfigOptions = {}) {
  const settings = readSettings();
  const configPath = settings.devnet.configPath;

  try {
    const editor = createDevnetConfigEditor(configPath);

    if (options.set && options.set.length > 0) {
      const parsedItems = applySetItems(editor, options.set);
      logger.success(`Devnet config updated at: ${configPath}`);
      logger.info(
        `Applied ${parsedItems.length} setting(s): ${parsedItems.map((item) => `${item.key}=${item.value}`).join(', ')}`,
      );
      logger.info('Restart devnet to apply changes: offckb clean -d && offckb node');
      return;
    }

    const isSaved = await runDevnetConfigTui(editor, configPath);

    if (isSaved) {
      logger.success(`Devnet config updated at: ${configPath}`);
      logger.info('Restart devnet to apply changes: offckb clean -d && offckb node');
      return;
    }

    logger.info('No changes saved.');
  } catch (error) {
    logger.error((error as Error).message);
    logger.info('Tip: run `offckb node` once to initialize devnet config files first.');
    process.exitCode = 1;
  }
}
