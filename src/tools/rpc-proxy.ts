import httpProxy from 'http-proxy';
import http from 'http';
import { Network } from '../type/base';
import fs from 'fs';
import { readSettings } from '../cfg/setting';
import path from 'path';

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
      try {
        const jsonRpcContent = JSON.parse(reqData);
        const method = jsonRpcContent.method;
        const params = jsonRpcContent.params;
        console.debug('RPC Req: ', method);

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
            console.debug(`RPC Req:  store tx ${txHash}`);
          }
        }
      } catch (err) {
        logger.error('Error parsing JSON-RPC content:', err);
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
      try {
        const jsonRpcResponse = JSON.parse(res);
        const error = jsonRpcResponse.error;
        if (error) {
          console.debug('RPC Response: ', jsonRpcResponse);
        }
      } catch (err) {
        logger.error('Error parsing JSON-RPC content:', err);
      }
    });
  });

  const server = http.createServer((req, res) => {
    proxy.web(req, res, {}, (err) => {
      if (err) {
        console.error('Proxy error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy error');
      }
    });
  });

  return {
    network,
    start: () => {
      return server.listen(port, () => {
        console.debug(`CKB ${network} RPC Proxy server running on http://localhost:${port}`);
      });
    },
    stop: () => {
      return server.close();
    },
  };
}
