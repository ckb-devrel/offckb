import fs from 'fs';
import path from 'path';
import toml, { JsonMap } from '@iarna/toml';

type FieldType = 'string' | 'number' | 'boolean';

type EditableFieldValue = string | number | boolean;

export type TomlPrimitive = string | number | boolean;
export type TomlValue = TomlPrimitive | TomlObject | TomlValue[];
export interface TomlObject {
  [key: string]: TomlValue;
}

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

export interface TomlDocument {
  id: 'ckb' | 'miner';
  title: string;
  filePath: string;
  data: TomlObject;
}

export interface TomlEntry {
  documentId: 'ckb' | 'miner';
  path: string[];
  pathText: string;
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  valuePreview: string;
  editable: boolean;
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

const safeFieldDefinitionMap = new Map(
  editableFieldDefinitions.map((definition) => [
    `${definition.file}:${definition.path.map((item) => String(item)).join('.')}`,
    definition,
  ]),
);

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isTomlPrimitive(value: unknown): value is TomlPrimitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function getTypeOfTomlValue(value: unknown): TomlEntry['type'] {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (isPlainObject(value)) {
    return 'object';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  return 'boolean';
}

function valuePreview(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).length}}`;
  }
  if (typeof value === 'string') {
    if (value.length > 80) {
      return `${value.slice(0, 80)}...`;
    }
    return value;
  }
  return String(value);
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

function parseValueByExistingType(rawInput: string, existingValue: unknown): TomlPrimitive {
  if (typeof existingValue === 'boolean') {
    const parsedBoolean = normalizeBooleanInput(rawInput);
    if (parsedBoolean == null) {
      throw new Error('Boolean value must be one of: true/false/yes/no/1/0.');
    }
    return parsedBoolean;
  }

  if (typeof existingValue === 'number') {
    const parsedNumber = Number(rawInput.trim());
    if (!Number.isFinite(parsedNumber)) {
      throw new Error('Number value must be finite.');
    }
    return parsedNumber;
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Value cannot be empty.');
  }
  return trimmed;
}

function parseInputAsTomlPrimitive(rawInput: string): TomlPrimitive {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('Value cannot be empty.');
  }

  const parsedBoolean = normalizeBooleanInput(trimmed);
  if (parsedBoolean != null) {
    return parsedBoolean;
  }

  const parsedNumber = Number(trimmed);
  if (!Number.isNaN(parsedNumber) && Number.isFinite(parsedNumber)) {
    return parsedNumber;
  }

  return trimmed;
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
  private documents: Record<'ckb' | 'miner', TomlDocument>;

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

    this.documents = {
      ckb: {
        id: 'ckb',
        title: 'ckb.toml',
        filePath: this.ckbTomlPath,
        data: this.ckbConfig as TomlObject,
      },
      miner: {
        id: 'miner',
        title: 'ckb-miner.toml',
        filePath: this.minerTomlPath,
        data: this.minerConfig as TomlObject,
      },
    };
  }

  getDocuments(): TomlDocument[] {
    return [this.documents.ckb, this.documents.miner];
  }

  getDocument(documentId: 'ckb' | 'miner'): TomlDocument {
    return this.documents[documentId];
  }

  getEntriesForDocument(documentId: 'ckb' | 'miner'): TomlEntry[] {
    const entries: TomlEntry[] = [];
    const document = this.getDocument(documentId);

    const walk = (value: unknown, currentPath: string[]) => {
      if (currentPath.length > 0) {
        const entryType = getTypeOfTomlValue(value);
        entries.push({
          documentId,
          path: currentPath,
          pathText: currentPath.join('.'),
          type: entryType,
          valuePreview: valuePreview(value),
          editable: entryType === 'string' || entryType === 'number' || entryType === 'boolean',
        });
      }

      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...currentPath, String(index)]));
        return;
      }

      if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
          walk(value[key], [...currentPath, key]);
        }
      }
    };

    walk(document.data, []);
    return entries;
  }

  getEntryValue(documentId: 'ckb' | 'miner', pathParts: string[]): unknown {
    return getByPath(this.getDocument(documentId).data as Record<string, unknown>, pathParts);
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
      setByPath(
        this.getDocument(definition.file).data as Record<string, unknown>,
        definition.path,
        this.values[fieldId],
      );
      return this.values[fieldId];
    }

    if (definition.type === 'number') {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('Value must be a positive integer.');
      }

      this.values[fieldId] = parsed;
      setByPath(
        this.getDocument(definition.file).data as Record<string, unknown>,
        definition.path,
        this.values[fieldId],
      );
      return this.values[fieldId];
    }

    const parsedBoolean = normalizeBooleanInput(trimmed);
    if (parsedBoolean == null) {
      throw new Error('Boolean value must be one of: true/false/yes/no/1/0.');
    }

    this.values[fieldId] = parsedBoolean;
    setByPath(
      this.getDocument(definition.file).data as Record<string, unknown>,
      definition.path,
      this.values[fieldId],
    );
    return this.values[fieldId];
  }

  setDocumentValue(documentId: 'ckb' | 'miner', pathParts: string[], rawInput: string): TomlPrimitive {
    if (pathParts.length === 0) {
      throw new Error('Cannot edit the root node.');
    }

    const fileKey = `${documentId}:${pathParts.join('.')}`;
    const safeDefinition = safeFieldDefinitionMap.get(fileKey);
    if (safeDefinition != null) {
      return this.setFieldValue(safeDefinition.id, rawInput);
    }

    const document = this.getDocument(documentId);
    const currentValue = getByPath(document.data as Record<string, unknown>, pathParts);
    if (!isTomlPrimitive(currentValue)) {
      throw new Error('Only primitive values can be edited directly.');
    }

    const parsedValue = parseValueByExistingType(rawInput, currentValue);
    setByPath(document.data as Record<string, unknown>, pathParts, parsedValue);
    return parsedValue;
  }

  addObjectEntry(documentId: 'ckb' | 'miner', pathParts: string[], key: string, rawValue: string): TomlPrimitive {
    const target = getByPath(this.getDocument(documentId).data as Record<string, unknown>, pathParts);
    if (!isPlainObject(target)) {
      throw new Error('Target path is not an object.');
    }

    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('Key cannot be empty.');
    }
    if (normalizedKey in target) {
      throw new Error(`Key '${normalizedKey}' already exists.`);
    }

    const parsedValue = parseInputAsTomlPrimitive(rawValue);
    target[normalizedKey] = parsedValue;
    return parsedValue;
  }

  appendArrayEntry(documentId: 'ckb' | 'miner', pathParts: string[], rawValue: string): TomlPrimitive {
    const target = getByPath(this.getDocument(documentId).data as Record<string, unknown>, pathParts);
    if (!Array.isArray(target)) {
      throw new Error('Target path is not an array.');
    }

    const parsedValue = parseInputAsTomlPrimitive(rawValue);
    target.push(parsedValue);
    return parsedValue;
  }

  insertArrayEntry(
    documentId: 'ckb' | 'miner',
    pathParts: string[],
    index: number,
    rawValue: string,
  ): TomlPrimitive {
    const target = getByPath(this.getDocument(documentId).data as Record<string, unknown>, pathParts);
    if (!Array.isArray(target)) {
      throw new Error('Target path is not an array.');
    }

    if (!Number.isInteger(index) || index < 0 || index > target.length) {
      throw new Error(`Insert index must be between 0 and ${target.length}.`);
    }

    const parsedValue = parseInputAsTomlPrimitive(rawValue);
    target.splice(index, 0, parsedValue);
    return parsedValue;
  }

  moveArrayEntry(documentId: 'ckb' | 'miner', pathParts: string[], fromIndex: number, toIndex: number): void {
    const target = getByPath(this.getDocument(documentId).data as Record<string, unknown>, pathParts);
    if (!Array.isArray(target)) {
      throw new Error('Target path is not an array.');
    }

    if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= target.length) {
      throw new Error(`Source index must be between 0 and ${Math.max(0, target.length - 1)}.`);
    }
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= target.length) {
      throw new Error(`Target index must be between 0 and ${Math.max(0, target.length - 1)}.`);
    }

    if (fromIndex === toIndex) {
      return;
    }

    const [item] = target.splice(fromIndex, 1);
    target.splice(toIndex, 0, item);
  }

  deleteDocumentPath(documentId: 'ckb' | 'miner', pathParts: string[]): void {
    if (pathParts.length === 0) {
      throw new Error('Cannot delete the root node.');
    }

    const parentPath = pathParts.slice(0, -1);
    const key = pathParts[pathParts.length - 1];
    const parent = getByPath(this.getDocument(documentId).data as Record<string, unknown>, parentPath);

    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
        throw new Error('Invalid array index for deletion.');
      }
      parent.splice(index, 1);
      return;
    }

    if (isPlainObject(parent)) {
      if (!(key in parent)) {
        throw new Error(`Key '${key}' does not exist.`);
      }
      delete parent[key];
      return;
    }

    throw new Error('Target path cannot be deleted.');
  }

  toggleBooleanField(fieldId: string): EditableFieldValue {
    const field = this.getField(fieldId);
    if (field.type !== 'boolean') {
      throw new Error(`Field '${fieldId}' is not boolean.`);
    }

    const nextValue = !field.value;
    this.values[fieldId] = nextValue;
    setByPath(
      this.getDocument(field.file).data as Record<string, unknown>,
      field.path,
      nextValue,
    );
    return nextValue;
  }

  save(): void {
    writeTomlFileAtomic(this.ckbTomlPath, this.documents.ckb.data as unknown as Record<string, unknown>);
    writeTomlFileAtomic(this.minerTomlPath, this.documents.miner.data as unknown as Record<string, unknown>);
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
