import httpProxy from 'http-proxy';
import http from 'http';
import { Network } from '../type/base';
import fs from 'fs';
import { readSettings } from '../cfg/setting';
import path from 'path';
import { logger } from '../util/logger';

// todo: if we use import this throws error in tsc building
const { cccA } = require('@ckb-ccc/core/advanced');

export function createRPCProxy(network: Network, targetRpcUrl: string, port: number) {
  const proxy = httpProxy.createProxyServer({
    target: targetRpcUrl, // Target RPC server
  });

  proxy.on('proxyReq', (_, req) => {
    let reqData = '';
    req.on('data', (chunk) => {
      reqData += chunk;
    });
    req.on('end', () => {
      if (reqData.length === 0) return;

      try {
        const jsonRpcContent = JSON.parse(reqData);
        const method = jsonRpcContent.method;
        const params = jsonRpcContent.params;
        logger.info('RPC Req: ', method);

        if (method === 'send_transaction') {
          const tx = params[0];
          // todo: record tx
          if (network === Network.devnet) {
            const cccTx = cccA.JsonRpcTransformers.transactionTo(tx);
            const txHash = cccTx.hash();
            const settings = readSettings();
            if (!fs.existsSync(settings.devnet.transactionsPath)) {
              fs.mkdirSync(settings.devnet.transactionsPath);
            }
            const txFile = path.resolve(settings.devnet.transactionsPath, `${txHash}.json`);
            fs.writeFileSync(txFile, JSON.stringify(tx, null, 2));
            logger.debug(`RPC Req:  store tx ${txHash}`);
          }
        }
      } catch (err) {
        logger.error('Error parsing JSON-RPC req content:', (err as Error).message);
      }
    });
  });

  proxy.on('proxyRes', function (proxyRes, _req, _res) {
    const body: Buffer[] = [];
    proxyRes.on('data', function (chunk) {
      body.push(chunk);
    });
    proxyRes.on('end', function () {
      const res = Buffer.concat(body).toString();
      if (res.length === 0) return;
      try {
        const jsonRpcResponse = JSON.parse(res);
        const error = jsonRpcResponse.error;
        if (error) {
          logger.debug('RPC Response: ', jsonRpcResponse);
        }
      } catch (err) {
        logger.error('Error parsing JSON-RPC res content:', (err as Error).message);
      }
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
