import { configPath, readSettings, writeSettings } from '../cfg/setting';
import { Request } from '../util/request';
import { isValidVersion } from '../util/validator';
import { logger } from '../util/logger';

export enum ConfigAction {
  list = 'list',
  get = 'get',
  set = 'set',
  rm = 'rm',
}

export enum ConfigItem {
  proxy = 'proxy',
  ckbVersion = 'ckb-version',
}

export async function Config(action: ConfigAction, item: ConfigItem, value?: string) {
  if (action === ConfigAction.list) {
    logger.info('config file: ', configPath);
    return logger.info(JSON.stringify(readSettings(), null, 2));
  }

  if (action === ConfigAction.get) {
    switch (item) {
      case ConfigItem.proxy: {
        const settings = readSettings();
        const proxy = settings.proxy;
        if (proxy == null) {
          logger.info(`No Proxy.`);
          process.exit(0);
        }
        return logger.info(`${Request.proxyConfigToUrl(proxy)}`);
      }

      case ConfigItem.ckbVersion: {
        const settings = readSettings();
        const version = settings.bins.defaultCKBVersion;
        return logger.info(`${version}`);
      }

      default:
        break;
    }
  }

  if (action === ConfigAction.set) {
    switch (item) {
      case ConfigItem.proxy: {
        if (value == null) throw new Error('No proxyUrl!');

        try {
          const proxy = Request.parseProxyUrl(value);
          const settings = readSettings();
          settings.proxy = proxy;
          return writeSettings(settings);
        } catch (error: unknown) {
          return logger.error(`invalid proxyURL, `, (error as Error).message);
        }
      }

      case ConfigItem.ckbVersion: {
        const settings = readSettings();
        try {
          if (isValidVersion(value)) {
            const version = extractVersion(value!);
            settings.bins.defaultCKBVersion = version;
            return writeSettings(settings);
          } else {
            return logger.error(
              `invalid version value, ${value}. Check available versions on https://github.com/nervosnetwork/ckb/tags`,
            );
          }
        } catch (error: unknown) {
          return logger.error(`invalid version value, `, (error as Error).message);
        }
      }

      default:
        break;
    }
  }

  if (action === ConfigAction.rm) {
    switch (item) {
      case ConfigItem.proxy: {
        const settings = readSettings();
        settings.proxy = undefined;
        return writeSettings(settings);
      }

      default:
        break;
    }
  }

  throw new Error('invalid config action.');
}

function extractVersion(version: string): string {
  // If the version starts with 'v', remove it
  return version.startsWith('v') ? version.slice(1) : version;
}
