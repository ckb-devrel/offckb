import fs from 'fs';
import os from 'os';
import path from 'path';
import toml from '@iarna/toml';
import { createDevnetConfigEditor } from '../src/devnet/config-editor';
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
        modules: ['Net', 'Pool', 'Miner', 'Chain', 'Stats', 'Subscription', 'Experiment', 'Debug', 'Indexer'],
      },
      network: {
        max_peers: 125,
        bootnodes: ['node-a', 'node-b'],
        support_protocols: ['Ping', 'Discovery', 'Identify', 'Sync'],
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

  it('provides full TOML document and flattened entries', () => {
    const editor = createDevnetConfigEditor(configPath);

    const documents = editor.getDocuments();
    expect(documents.map((document) => document.id)).toEqual(['ckb', 'miner']);

    const ckbEntries = editor.getEntriesForDocument('ckb');
    expect(ckbEntries.some((entry) => entry.pathText === 'logger.filter')).toBe(true);
    expect(ckbEntries.some((entry) => entry.pathText === 'network.max_peers')).toBe(true);
  });

  it('edits primitive value via generic document path api', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.setDocumentValue('ckb', ['network', 'max_peers'], '256');
    editor.save();

    const ckbToml = toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8')) as unknown as Record<
      string,
      any
    >;
    expect(ckbToml.network.max_peers).toBe(256);
  });

  it('inserts and moves array entries via document path api', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.insertArrayEntry('ckb', ['network', 'bootnodes'], 1, 'node-x');
    editor.moveArrayEntry('ckb', ['network', 'bootnodes'], 2, 0);
    editor.save();

    const ckbToml = toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8')) as unknown as Record<
      string,
      any
    >;

    expect(ckbToml.network.bootnodes).toEqual(['node-b', 'node-a', 'node-x']);
  });

  it('allows custom rpc modules and preserves them on save', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.setArrayValues('ckb', ['rpc', 'modules'], ['Net', 'Indexer', 'CustomModuleX']);
    editor.save();

    const ckbToml = toml.parse(fs.readFileSync(path.join(configPath, 'ckb.toml'), 'utf8')) as unknown as Record<
      string,
      any
    >;

    expect(ckbToml.rpc.modules).toEqual(['Net', 'Indexer', 'CustomModuleX']);
  });

  it('rejects saving when support_protocols misses mandatory protocols', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.setArrayValues('ckb', ['network', 'support_protocols'], ['Ping', 'Discovery']);

    expect(() => editor.save()).toThrow('network.support_protocols must include both Sync and Identify');
  });

  it('rejects saving when rpc.modules is empty', () => {
    const editor = createDevnetConfigEditor(configPath);

    editor.setArrayValues('ckb', ['rpc', 'modules'], []);

    expect(() => editor.save()).toThrow('rpc.modules must include at least one module');
  });
});
