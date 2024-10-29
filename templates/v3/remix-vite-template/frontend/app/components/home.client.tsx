import { Wallet } from './wallet.client';
import { ccc } from '@ckb-ccc/connector-react';
import offckb from 'offckb.config';

export default function Home() {
  const isScriptDeployed = offckb.myScripts['hello-world'] != null;
  return (
    <ccc.Provider>
      <div className="max-w-screen-md mx-auto mt-10">
        <div className="text-3xl font-bold">Minimal Template for CKB DApp</div>
        <div>
          <a href="https://docs.nervos.org/docs/getting-started/quick-start" target="_blank" rel="noopener noreferrer">
            Development docs
          </a>
        </div>

        <div className="my-6">
          <div className="text-xl font-semibold my-2">Tech Stack</div>
          <li>
            <a target="_blank" href="https://github.com/cryptape/ckb-script-templates" rel="noreferrer">
              ckb-scripts-template
            </a>{' '}
            for smart contract development in Rust
          </li>
          <li>
            <a target="_blank" href="https://remix.run/tutorials/blog" rel="noreferrer">
              remix-vite
            </a>{' '}
            for Javascript frontend framework
          </li>
          <li>
            <a href="https://github.com/ckb-devrel/ccc" target="_blank" rel="noopener noreferrer">
              CCC
            </a>{' '}
            for off-chain CKB SDK
          </li>
        </div>

        <div className="my-6">
          <div className="text-xl font-semibold my-2">CKB Blockchain</div>
          <li>
            Current Network: {offckb.currentNetwork}, Address Prefix: {offckb.addressPrefix}
          </li>
          <li>
            CKB RPC URL:{' '}
            <a href={offckb.rpcUrl} target="_blank" rel="noopener noreferrer">
              {offckb.rpcUrl}
            </a>
          </li>
          <li>
            Switch different networks with Env{' '}
            <a
              href="https://github.com/RetricSu/offckb/blob/master/templates/remix-vite-template/README.md#dapp-frontend-development"
              target="_blank"
              rel="noopener noreferrer"
            >
              NETWORK
            </a>
          </li>
        </div>

        <div className="my-6">
          <div className="text-xl font-semibold my-2">Smart Contract</div>
          <div>
            hello-world Script{' '}
            {isScriptDeployed ? (
              <div>
                <li>code_hash: {offckb.myScripts['hello-world']?.codeHash}</li>
                <li>hash_type: {offckb.myScripts['hello-world']?.hashType}</li>
                <li>
                  outpoint: {offckb.myScripts['hello-world']?.cellDeps[0].cellDep.outPoint.txHash}:
                  {offckb.myScripts['hello-world']?.cellDeps[0].cellDep.outPoint.index}
                </li>
              </div>
            ) : (
              <span>
                Not Found,{' '}
                <a
                  href="https://github.com/RetricSu/offckb/blob/master/templates/remix-vite-template/README.md#deploy-to-devnettestnet-with-offckb"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  deploy
                </a>{' '}
                it first.
              </span>
            )}
          </div>
        </div>

        <div className="my-6">
          <div className="text-xl font-semibold my-2">Wallet Connector</div>
          <div className="text-left">
            <Wallet />
          </div>
        </div>

        <div className="my-12 text-gray-500 italic">
          <hr className="h-px my-4 bg-gray-200 border-0 dark:bg-gray-700" />
          This template is created by{' '}
          <a href="https://github.com/RetricSu/offckb" target="_blank" rel="noopener noreferrer">
            offckb
          </a>
        </div>
      </div>
    </ccc.Provider>
  );
}
