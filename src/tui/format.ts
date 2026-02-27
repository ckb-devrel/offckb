import { TomlEntry } from '../node/devnet-config-editor';
import { getConfigDoc, getFixedArraySpecFromEntryPath } from './devnet-config-metadata';

function formatFixedArrayInline(values: string[], options: string[]): string {
  const selectedSet = new Set(values);
  const optionSet = new Set(options);
  const customCount = values.filter((value) => !optionSet.has(value)).length;

  const optionChunks = options.map((option) => {
    const marker = selectedSet.has(option) ? '{green-fg}[x]{/green-fg}' : '{245-fg}[ ]{/245-fg}';
    return `${marker}${option}`;
  });

  if (customCount > 0) {
    optionChunks.push(`{yellow-fg}[+${customCount} custom]{/yellow-fg}`);
  }

  return optionChunks.join(' ');
}

export function formatFixedArrayDetailLine(depth: number, values: string[], options: string[]): string {
  const detailIndent = `${'│ '.repeat(Math.max(0, depth))}  `;
  return `${detailIndent}${formatFixedArrayInline(values, options)}`;
}

export function formatEntryLine(entry: TomlEntry, entryValue?: unknown): string {
  const depth = Math.max(0, entry.path.length - 1);
  const lastPathPart = entry.path[entry.path.length - 1] ?? '';
  const nodeName = /^\d+$/.test(lastPathPart) ? `[${lastPathPart}]` : lastPathPart;
  const treeIndent = depth === 0 ? '' : `${'│ '.repeat(Math.max(0, depth - 1))}`;
  const branch = depth === 0 ? '' : '├─ ';
  const keyDoc = getConfigDoc(entry.path);
  const docText = keyDoc != null ? ` {245-fg}// ${keyDoc.summary}{/245-fg}` : '';
  const valueColor = entry.type === 'string' ? 'green' : entry.type === 'number' ? 'yellow' : 'magenta';
  const keyColor = depth === 0 ? 'cyan' : 'white';

  if (entry.type === 'object') {
    return `${treeIndent}${branch}{cyan-fg}▸ ${nodeName}{/cyan-fg} {gray-fg}${entry.valuePreview}{/gray-fg}${docText}`;
  }

  if (entry.type === 'array') {
    const fixedArraySpec = getFixedArraySpecFromEntryPath(entry.path);
    const fixedArrayTag = fixedArraySpec != null ? ' {green-fg}[editable set]{/green-fg}' : '';
    return `${treeIndent}${branch}{magenta-fg}▾ ${nodeName}{/magenta-fg} {gray-fg}${entry.valuePreview}{/gray-fg}${fixedArrayTag}${docText}`;
  }

  return `${treeIndent}${branch}{${keyColor}-fg}${nodeName}{/${keyColor}-fg} = {${valueColor}-fg}${entry.valuePreview}{/${valueColor}-fg}${docText}`;
}
