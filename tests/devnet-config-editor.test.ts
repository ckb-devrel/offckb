import fs from 'fs';
import os from 'os';
import path from 'path';
import toml from '@iarna/toml';
import { createDevnetConfigEditor } from '../src/node/devnet-config-editor';
import { applySetItems, parseSetItem } from '../src/cmd/devnet-config';

function writeFixtureConfig(configPath: string) {
  fs.mkdirSync(configPath, { recursive: true });

  fs.writeFileSync(
    path.join(configPath, 'ckb.toml'),
    toml.stringify({
      logger: {
        filter: 'warn,ckb-script=debug',
        color: true,
        log_to_file: true,
        log_to_stdout: true,
      },
      rpc: {
        listen_address: '0.0.0.0:8114',
        max_request_body_size: 10_485_760,
        enable_deprecated_rpc: false,
      },
      network: {
        max_peers: 125,
      },
    }),
    'utf8',
  );

  fs.writeFileSync(
    path.join(configPath, 'ckb-miner.toml'),
    toml.stringify({
      miner: {
        client: {
          rpc_url: 'http://ckb:8114/',
          block_on_submit: true,
          poll_interval: 1000,
        },
      },
    }),
    'utf8',
  );
}

describe('DevnetConfigEditor', () => {
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offckb-devnet-config-'));
    configPath = path.join(tempRoot, 'devnet');
    writeFixtureConfig(configPath);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('loads editable safe-subset fields', () => {
    const editor = createDevnetConfigEditor(configPath);
    const fields = editor.getFields();

    expect(fields.length).toBe(10);
    expect(fields.find((field) => field.id === 'ckb.rpc.listen_address')?.value).toBe('0.0.0.0:8114');
    expect(fields.find((field) => field.id === 'miner.client.poll_interval')?.value).toBe(1000);
  });

  it('validates updated values', () => {
    const editor = createDevnetConfigEditor(configPath);

    expect(() => editor.setFieldValue('ckb.rpc.listen_address', 'invalid')).toThrow(
      'RPC listen address must be in host:port format.',
    );

    expect(() => editor.setFieldValue('miner.client.rpc_url', 'ftp://ckb:8114/')).toThrow(
      'Miner RPC URL must be a valid HTTP/HTTPS URL.',
    );

    expect(() => editor.setFieldValue('miner.client.poll_interval', '0')).toThrow('Value must be a positive integer.');
  });

  it('saves edited values and keeps unrelated keys', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.setFieldValue('ckb.logger.filter', 'info');
    editor.setFieldValue('ckb.rpc.listen_address', '127.0.0.1:18114');
    editor.setFieldValue('miner.client.poll_interval', '500');
    editor.toggleBooleanField('ckb.rpc.enable_deprecated_rpc');
    editor.save();

    const ckbToml = toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8')) as unknown as Record<
      string,
      any
    >;
    const minerToml = toml.parse(
      fs.readFileSync(path.join(configPath, 'ckb-miner.toml'), 'utf8'),
    ) as unknown as Record<string, any>;

    expect(ckbToml.logger.filter).toBe('info');
    expect(ckbToml.rpc.listen_address).toBe('127.0.0.1:18114');
    expect(ckbToml.rpc.enable_deprecated_rpc).toBe(true);
    expect(ckbToml.network.max_peers).toBe(125);
    expect(minerToml.miner.client.poll_interval).toBe(500);
  });

  it('throws when config files are missing', () => {
    fs.rmSync(path.join(configPath, 'ckb-miner.toml'));
    expect(() => createDevnetConfigEditor(configPath)).toThrow('Missing file');
  });

  it('parses --set key=value items', () => {
    expect(parseSetItem('ckb.logger.filter=info')).toEqual({
      key: 'ckb.logger.filter',
      value: 'info',
    });

    expect(() => parseSetItem('ckb.logger.filter')).toThrow('Invalid --set item');
    expect(() => parseSetItem('=info')).toThrow('Invalid --set item');
  });

  it('applies repeatable --set items and persists files', () => {
    const editor = createDevnetConfigEditor(configPath);

    const applied = applySetItems(editor, [
      'ckb.logger.filter=info',
      'ckb.rpc.enable_deprecated_rpc=true',
      'miner.client.poll_interval=1500',
    ]);

    expect(applied).toHaveLength(3);

    const ckbToml = toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8')) as unknown as Record<
      string,
      any
    >;
    const minerToml = toml.parse(
      fs.readFileSync(path.join(configPath, 'ckb-miner.toml'), 'utf8'),
    ) as unknown as Record<string, any>;

    expect(ckbToml.logger.filter).toBe('info');
    expect(ckbToml.rpc.enable_deprecated_rpc).toBe(true);
    expect(minerToml.miner.client.poll_interval).toBe(1500);
  });
});
