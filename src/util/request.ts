import { ProxyConfig, readSettings } from '../cfg/setting';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { RequestInit } from 'node-fetch';

export class Request {
  static proxy = readSettings().proxy;

  /** Fetch without an ok-check so callers can handle 404s themselves. */
  static async fetch(url: string, options: RequestInit = {}) {
    const agent = this.proxy ? new HttpsProxyAgent(this.proxyConfigToUrl(this.proxy)) : undefined;
    const opt: RequestInit = { ...{ agent }, ...options };
    try {
      return await fetch(url, opt);
    } catch (error: unknown) {
      throw new Error(`fetch error! ${(error as Error).message}`);
    }
  }

  static async send(url: string, options: RequestInit = {}) {
    const response = await this.fetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}, URL: ${response.url}`);
    }
    return await response;
  }

  static parseProxyUrl(url: string): ProxyConfig {
    const parsedUrl = new URL(url);

    const proxyConfig: ProxyConfig = {
      host: parsedUrl.hostname,
      port: parseInt(parsedUrl.port, 10),
    };

    if (parsedUrl.username || parsedUrl.password) {
      proxyConfig.auth = {
        username: parsedUrl.username,
        password: parsedUrl.password,
      };
    }

    if (parsedUrl.protocol) {
      proxyConfig.protocol = parsedUrl.protocol.slice(0, -1); // Remove the trailing ':'
    }

    return proxyConfig;
  }

  static proxyConfigToUrl(proxy: ProxyConfig): string {
    const protocol = proxy.protocol ? `${proxy.protocol}://` : '';
    const auth = proxy.auth ? `${proxy.auth.username}:${proxy.auth.password}@` : '';
    const port = proxy.port ? `:${proxy.port}` : '';

    return `${protocol}${auth}${proxy.host}${port}`;
  }
}
