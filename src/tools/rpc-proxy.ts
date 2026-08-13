import httpProxy from 'http-proxy';
import http from 'http';
import { Network } from '../type/base';
import { readSettings } from '../cfg/setting';
import { logger, UnifiedLogger } from '../util/logger';
import { proxyLogPathForNetwork } from '../devnet/log-file';
import {
  createProxyEventLog,
  handleProxyRequestBody,
  handleProxyResponseBody,
  ProxyEventContext,
} from './proxy-events';

// todo: if we use import this throws error in tsc building
const { cccA } = require('@ckb-ccc/core/advanced');

export interface RPCProxyOptions {
  // --verbose also lifts the proxy's per-request "RPC Req" lines from debug
  // to the console; without it they stay in proxy.log only.
  verbose?: boolean;
}

export function createRPCProxy(network: Network, targetRpcUrl: string, port: number, options: RPCProxyOptions = {}) {
  const settings = readSettings();
  const events = createProxyEventLog(proxyLogPathForNetwork(network, settings));
  // The global logger sits at info level, so a debug-level sink is needed for
  // verbose runs to actually see the per-request lines.
  const sink = options.verbose ? UnifiedLogger.create({ level: 'debug', showLevel: false }) : logger;
  const ctx: ProxyEventContext = {
    sink,
    events,
    transactionsPath: settings[network].transactionsPath,
    hashTransaction: (tx: unknown) => {
      const cccTx = cccA.JsonRpcTransformers.transactionTo(tx);
      return cccTx.hash() as string;
    },
  };

  const proxy = httpProxy.createProxyServer({
    target: targetRpcUrl, // Target RPC server
    changeOrigin: true, // for https target to work
  });

  proxy.on('proxyReq', (_, req) => {
    let reqData = '';
    req.on('data', (chunk) => {
      reqData += chunk;
    });
    req.on('end', () => handleProxyRequestBody(reqData, ctx));
  });

  proxy.on('proxyRes', function (proxyRes, _req, _res) {
    const body: Buffer[] = [];
    proxyRes.on('data', function (chunk) {
      body.push(chunk);
    });
    proxyRes.on('end', function () {
      const res = Buffer.concat(body).toString('utf-8');
      handleProxyResponseBody(res, proxyRes.headers['content-type'], ctx);
    });
  });

  const server = http.createServer((req, res) => {
    proxy.web(req, res, {}, (err) => {
      if (err) {
        logger.error('Proxy error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error');
      }
    });
  });

  return {
    network,
    start: () => {
      return server.listen(port, () => {
        logger.info(`CKB ${network} RPC Proxy server running on http://127.0.0.1:${port}`);
      });
    },
    stop: () => {
      return server.close();
    },
  };
}
