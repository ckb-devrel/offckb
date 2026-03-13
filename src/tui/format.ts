import { TomlEntry } from '../devnet/config-editor';
import { getConfigDoc } from './devnet-config-metadata';

function formatFixedArrayInline(values: string[]): string {
  if (values.length === 0) {
    return '{light-cyan-fg}[]{/light-cyan-fg}';
  }

  return `{light-cyan-fg}[${values.join(', ')}]{/light-cyan-fg}`;
}

export function formatFixedArrayDetailLine(depth: number, values: string[]): string {
  const detailIndent = `${'│ '.repeat(Math.max(0, depth))}  `;
  return `${detailIndent}${formatFixedArrayInline(values)}`;
}

export function formatEntryLine(entry: TomlEntry, _entryValue?: unknown): string {
  const depth = Math.max(0, entry.path.length - 1);
  const lastPathPart = entry.path[entry.path.length - 1] ?? '';
  const nodeName = /^\d+$/.test(lastPathPart) ? `[${lastPathPart}]` : lastPathPart;
  const treeIndent = depth === 0 ? '' : `${'│ '.repeat(Math.max(0, depth - 1))}`;
  const branch = depth === 0 ? '' : '├─ ';
  const keyDoc = getConfigDoc(entry.path);
  const docText = keyDoc != null ? ` {243-fg}// ${keyDoc.summary}{/243-fg}` : '';
  const valueColor = entry.type === 'string' ? 'green' : entry.type === 'number' ? 'yellow' : 'magenta';
  const keyColor = depth === 0 ? 'cyan' : 'white';

  if (entry.type === 'object') {
    return `${treeIndent}${branch}{cyan-fg}▸ ${nodeName}{/cyan-fg} {gray-fg}${entry.valuePreview}{/gray-fg}${docText}`;
  }

  if (entry.type === 'array') {
    return `${treeIndent}${branch}{magenta-fg}▾ ${nodeName}{/magenta-fg} {white-fg}${entry.valuePreview}{/white-fg}${docText}`;
  }

  return `${treeIndent}${branch}{${keyColor}-fg}${nodeName}{/${keyColor}-fg} = {${valueColor}-fg}${entry.valuePreview}{/${valueColor}-fg}${docText}`;
}
