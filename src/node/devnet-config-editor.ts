import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';

type FieldType = 'string' | 'number' | 'boolean';

type EditableFieldValue = string | number | boolean;

interface EditableFieldDefinition {
  id: string;
  file: 'ckb' | 'miner';
  label: string;
  description: string;
  type: FieldType;
  path: Array<string | number>;
}

export interface EditableField extends EditableFieldDefinition {
  value: EditableFieldValue;
}

const editableFieldDefinitions: EditableFieldDefinition[] = [
  {
    id: 'ckb.logger.filter',
    file: 'ckb',
    label: 'Logger filter',
    description: 'CKB log filter string',
    type: 'string',
    path: ['logger', 'filter'],
  },
  {
    id: 'ckb.logger.color',
    file: 'ckb',
    label: 'Logger color output',
    description: 'Enable colorful logs',
    type: 'boolean',
    path: ['logger', 'color'],
  },
  {
    id: 'ckb.logger.log_to_file',
    file: 'ckb',
    label: 'Logger output to file',
    description: 'Write logs to file',
    type: 'boolean',
    path: ['logger', 'log_to_file'],
  },
  {
    id: 'ckb.logger.log_to_stdout',
    file: 'ckb',
    label: 'Logger output to stdout',
    description: 'Write logs to stdout',
    type: 'boolean',
    path: ['logger', 'log_to_stdout'],
  },
  {
    id: 'ckb.rpc.listen_address',
    file: 'ckb',
    label: 'RPC listen address',
    description: 'Host:port for CKB RPC',
    type: 'string',
    path: ['rpc', 'listen_address'],
  },
  {
    id: 'ckb.rpc.max_request_body_size',
    file: 'ckb',
    label: 'RPC max request body size',
    description: 'Maximum request body size in bytes',
    type: 'number',
    path: ['rpc', 'max_request_body_size'],
  },
  {
    id: 'ckb.rpc.enable_deprecated_rpc',
    file: 'ckb',
    label: 'Enable deprecated RPC',
    description: 'Allow deprecated CKB RPC methods',
    type: 'boolean',
    path: ['rpc', 'enable_deprecated_rpc'],
  },
  {
    id: 'miner.client.rpc_url',
    file: 'miner',
    label: 'Miner RPC URL',
    description: 'CKB node URL used by miner',
    type: 'string',
    path: ['miner', 'client', 'rpc_url'],
  },
  {
    id: 'miner.client.block_on_submit',
    file: 'miner',
    label: 'Miner block on submit',
    description: 'Wait for submit result before next request',
    type: 'boolean',
    path: ['miner', 'client', 'block_on_submit'],
  },
  {
    id: 'miner.client.poll_interval',
    file: 'miner',
    label: 'Miner poll interval',
    description: 'Block template polling interval in milliseconds',
    type: 'number',
    path: ['miner', 'client', 'poll_interval'],
  },
];

function getByPath(target: Record<string, unknown>, keyPath: Array<string | number>): unknown {
  let current: unknown = target;
  for (const key of keyPath) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}

function setByPath(target: Record<string, unknown>, keyPath: Array<string | number>, value: unknown): void {
  if (keyPath.length === 0) {
    return;
  }

  let current: Record<string, unknown> = target;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const part = String(keyPath[i]);
    const next = current[part];
    if (next == null || typeof next !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[String(keyPath[keyPath.length - 1])] = value;
}

function validateHostPort(value: string): boolean {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    return false;
  }

  const port = Number(trimmed.slice(separator + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function validateHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeBooleanInput(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

function readTomlFile(filePath: string): Record<string, unknown> {
  const text = fs.readFileSync(filePath, 'utf8');
  return toml.parse(text) as unknown as Record<string, unknown>;
}

function writeTomlFileAtomic(filePath: string, data: Record<string, unknown>) {
  const tempFilePath = `${filePath}.tmp`;
  const text = toml.stringify(data as unknown as JsonMap);
  fs.writeFileSync(tempFilePath, text, 'utf8');
  fs.renameSync(tempFilePath, filePath);
}

export class DevnetConfigEditor {
  readonly configPath: string;
  readonly ckbTomlPath: string;
  readonly minerTomlPath: string;

  private ckbConfig: Record<string, unknown>;
  private minerConfig: Record<string, unknown>;
  private values: Record<string, EditableFieldValue>;

  constructor(configPath: string, ckbConfig: Record<string, unknown>, minerConfig: Record<string, unknown>) {
    this.configPath = configPath;
    this.ckbTomlPath = path.join(configPath, 'ckb.toml');
    this.minerTomlPath = path.join(configPath, 'ckb-miner.toml');
    this.ckbConfig = ckbConfig;
    this.minerConfig = minerConfig;

    this.values = {};
    for (const definition of editableFieldDefinitions) {
      const source = definition.file === 'ckb' ? this.ckbConfig : this.minerConfig;
      const value = getByPath(source, definition.path);
      if (value == null) {
        throw new Error(`Unsupported config layout: missing field '${definition.id}' in devnet config files.`);
      }

      if (definition.type === 'string' && typeof value !== 'string') {
        throw new Error(`Unexpected type for '${definition.id}', expected string.`);
      }
      if (definition.type === 'number' && typeof value !== 'number') {
        throw new Error(`Unexpected type for '${definition.id}', expected number.`);
      }
      if (definition.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`Unexpected type for '${definition.id}', expected boolean.`);
      }

      this.values[definition.id] = value as EditableFieldValue;
    }
  }

  getFields(): EditableField[] {
    return editableFieldDefinitions.map((definition) => ({
      ...definition,
      value: this.values[definition.id],
    }));
  }

  getField(fieldId: string): EditableField {
    const definition = editableFieldDefinitions.find((item) => item.id === fieldId);
    if (definition == null) {
      throw new Error(`Unknown field '${fieldId}'.`);
    }

    return {
      ...definition,
      value: this.values[definition.id],
    };
  }

  setFieldValue(fieldId: string, rawInput: string): EditableFieldValue {
    const definition = editableFieldDefinitions.find((item) => item.id === fieldId);
    if (definition == null) {
      throw new Error(`Unknown field '${fieldId}'.`);
    }

    const trimmed = rawInput.trim();
    if (definition.type === 'string') {
      if (!trimmed) {
        throw new Error('Value cannot be empty.');
      }

      if (definition.id === 'ckb.rpc.listen_address' && !validateHostPort(trimmed)) {
        throw new Error('RPC listen address must be in host:port format.');
      }

      if (definition.id === 'miner.client.rpc_url' && !validateHttpUrl(trimmed)) {
        throw new Error('Miner RPC URL must be a valid HTTP/HTTPS URL.');
      }

      this.values[fieldId] = trimmed;
      return this.values[fieldId];
    }

    if (definition.type === 'number') {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('Value must be a positive integer.');
      }

      this.values[fieldId] = parsed;
      return this.values[fieldId];
    }

    const parsedBoolean = normalizeBooleanInput(trimmed);
    if (parsedBoolean == null) {
      throw new Error('Boolean value must be one of: true/false/yes/no/1/0.');
    }

    this.values[fieldId] = parsedBoolean;
    return this.values[fieldId];
  }

  toggleBooleanField(fieldId: string): EditableFieldValue {
    const field = this.getField(fieldId);
    if (field.type !== 'boolean') {
      throw new Error(`Field '${fieldId}' is not boolean.`);
    }

    const nextValue = !field.value;
    this.values[fieldId] = nextValue;
    return nextValue;
  }

  save(): void {
    for (const definition of editableFieldDefinitions) {
      const target = definition.file === 'ckb' ? this.ckbConfig : this.minerConfig;
      setByPath(target, definition.path, this.values[definition.id]);
    }

    writeTomlFileAtomic(this.ckbTomlPath, this.ckbConfig);
    writeTomlFileAtomic(this.minerTomlPath, this.minerConfig);
  }
}

export function createDevnetConfigEditor(configPath: string): DevnetConfigEditor {
  const ckbTomlPath = path.join(configPath, 'ckb.toml');
  const minerTomlPath = path.join(configPath, 'ckb-miner.toml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Devnet config path does not exist: ${configPath}`);
  }
  if (!fs.existsSync(ckbTomlPath)) {
    throw new Error(`Missing file: ${ckbTomlPath}`);
  }
  if (!fs.existsSync(minerTomlPath)) {
    throw new Error(`Missing file: ${minerTomlPath}`);
  }

  const ckbConfig = readTomlFile(ckbTomlPath);
  const minerConfig = readTomlFile(minerTomlPath);

  return new DevnetConfigEditor(configPath, ckbConfig, minerConfig);
}
