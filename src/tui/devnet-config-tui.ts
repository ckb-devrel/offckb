import blessed from 'blessed';
import fs from 'node:fs';
import path from 'path';
import { DevnetConfigEditor, TomlEntry } from '../devnet/config-editor';
import { getFixedArraySpecFromEntryPath } from './devnet-config-metadata';
import { formatEntryLine, formatFixedArrayDetailLine } from './format';
import { createTuiState, TuiWidgets } from './tui-state';
import { getListSelected } from './blessed-helpers';
import {
  ActionContext,
  editCurrentEntry,
  searchEntries,
  jumpSearchMatch,
  addEntry,
  deleteEntry,
  insertArrayEntry,
  moveArrayEntry,
  quitFlow,
  saveAndExit,
} from './actions';

interface EntryRenderRow {
  text: string;
  entryIndex: number;
  selectable: boolean;
}

// ---------------------------------------------------------------------------
// Visible-entry filter (compact fixed-array items + search term)
// ---------------------------------------------------------------------------

function getVisibleEntries(entries: TomlEntry[], searchTerm: string): TomlEntry[] {
  const compactEntries = entries.filter((entry) => {
    if (entry.path.length === 0) return true;
    const lastPathPart = entry.path[entry.path.length - 1];
    const isArrayItem = /^\d+$/.test(lastPathPart);
    if (!isArrayItem) return true;
    return getFixedArraySpecFromEntryPath(entry.path) == null;
  });

  const term = searchTerm.trim().toLowerCase();
  if (!term) return compactEntries;
  return compactEntries.filter((entry) => {
    const text = `${entry.pathText} ${entry.valuePreview} ${entry.type}`.toLowerCase();
    return text.includes(term);
  });
}

function escapeBlessedTags(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function styleTomlReferenceLine(line: string): string {
  const escapedLine = escapeBlessedTags(line);
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return escapedLine;
  }

  if (/^\[\[[^\]]+\]\]$/.test(trimmed)) {
    return `{magenta-fg}{bold}${escapedLine}{/bold}{/magenta-fg}`;
  }

  if (/^\[[^\]]+\]$/.test(trimmed)) {
    return `{cyan-fg}{bold}${escapedLine}{/bold}{/cyan-fg}`;
  }

  if (trimmed.startsWith('#')) {
    return `{250-fg}${escapedLine}{/250-fg}`;
  }

  const keyValueMatch = line.match(/^(\s*[^=\s][^=]*?\s*=\s*)(.*)$/);
  if (keyValueMatch != null) {
    const keyPart = escapeBlessedTags(keyValueMatch[1]);
    const rawValuePart = keyValueMatch[2] ?? '';

    const inlineCommentStart = rawValuePart.indexOf(' #');
    if (inlineCommentStart >= 0) {
      const valuePart = escapeBlessedTags(rawValuePart.slice(0, inlineCommentStart));
      const commentPart = escapeBlessedTags(rawValuePart.slice(inlineCommentStart));
      return `{yellow-fg}${keyPart}{/yellow-fg}{green-fg}${valuePart}{/green-fg}{250-fg}${commentPart}{/250-fg}`;
    }

    const valuePart = escapeBlessedTags(rawValuePart);
    return `{yellow-fg}${keyPart}{/yellow-fg}{green-fg}${valuePart}{/green-fg}`;
  }

  return escapedLine;
}

function styleTomlReference(source: string): string {
  return source.split('\n').map(styleTomlReferenceLine).join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDevnetConfigTui(editor: DevnetConfigEditor, configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a TTY terminal.');
  }

  // ---- state ----
  const state = createTuiState(editor, configPath);

  // ---- widgets ----
  const screen = blessed.screen({
    smartCSR: true,
    title: 'OffCKB Devnet Config Editor',
    fullUnicode: true,
    terminal: 'xterm',
  });

  const filesList = blessed.list({
    parent: screen,
    label: ' Files ',
    top: 0,
    left: 0,
    width: '20%',
    height: '100%-4',
    border: 'line',
    keys: true,
    vi: true,
    style: { selected: { bg: 'blue' }, border: { fg: 'gray' } },
    tags: true,
  });

  const entriesList = blessed.list({
    parent: screen,
    label: ' Config ',
    top: 0,
    left: '20%',
    width: '55%',
    height: '100%-4',
    border: 'line',
    keys: true,
    vi: true,
    style: { selected: { bg: 'blue' }, border: { fg: 'gray' } },
    tags: true,
  });

  const referenceBox = blessed.box({
    parent: screen,
    label: ' Reference (Read-Only) ',
    top: 0,
    left: '75%',
    width: '25%',
    height: '100%-4',
    border: 'line',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    style: { border: { fg: 'gray' } },
    content: '',
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 4,
    border: 'line',
    tags: true,
    content: '',
    style: { border: { fg: 'gray' } },
  });

  const widgets: TuiWidgets = { screen, filesList, entriesList, referenceBox, statusBar };
  let renderedRows: EntryRenderRow[] = [];
  let entryToRowIndex: number[] = [];
  const referenceTemplatesRoot = path.resolve(__dirname, '../../ckb/devnet');

  const getReferenceTemplateTitle = (documentId: 'ckb' | 'miner') =>
    documentId === 'ckb' ? 'ckb.toml' : 'ckb-miner.toml';

  const loadReferenceTemplate = (documentId: 'ckb' | 'miner'): string => {
    const title = getReferenceTemplateTitle(documentId);
    const filePath = path.join(referenceTemplatesRoot, title);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      return `Failed to load reference template:\n${filePath}\n\n${(error as Error).message}`;
    }
  };

  // ---- refresh ----
  const refreshUi = () => {
    const fileItems = state.documents.map((d) => d.title);
    filesList.setItems(fileItems);
    filesList.select(state.selectedDocumentIndex);

    const doc = state.documents[state.selectedDocumentIndex];
    const entries = state.editor.getEntriesForDocument(doc.id);
    state.visibleEntries = getVisibleEntries(entries, state.searchTerm);

    renderedRows = [];
    entryToRowIndex = [];
    let hasSeenTopLevelSection = false;

    state.visibleEntries.forEach((entry, entryIndex) => {
      if (entry.path.length === 1 && hasSeenTopLevelSection) {
        renderedRows.push({ text: ' ', entryIndex: -1, selectable: false });
      }
      if (entry.path.length === 1) {
        hasSeenTopLevelSection = true;
      }

      const entryValue = state.editor.getEntryValue(doc.id, entry.path);
      entryToRowIndex[entryIndex] = renderedRows.length;
      renderedRows.push({
        text: formatEntryLine(entry, entryValue),
        entryIndex,
        selectable: true,
      });

      const fixedArraySpec = entry.type === 'array' ? getFixedArraySpecFromEntryPath(entry.path) : null;
      if (fixedArraySpec != null && Array.isArray(entryValue)) {
        renderedRows.push({
          text: formatFixedArrayDetailLine(
            Math.max(0, entry.path.length - 1),
            entryValue.map((value) => String(value)),
          ),
          entryIndex,
          selectable: false,
        });
      }
    });

    entriesList.setItems(renderedRows.map((row) => row.text));

    filesList.style.border = { fg: state.focusPane === 'files' ? 'cyan' : 'gray' };
    entriesList.style.border = { fg: state.focusPane === 'entries' ? 'cyan' : 'gray' };
    referenceBox.style.border = { fg: state.focusPane === 'reference' ? 'cyan' : 'gray' };

    const referenceContent = styleTomlReference(loadReferenceTemplate(doc.id));
    referenceBox.setContent(referenceContent);

    if (state.visibleEntries.length === 0 || renderedRows.length === 0) {
      state.selectedEntryIndex = 0;
    } else {
      if (state.selectedEntryIndex >= state.visibleEntries.length) {
        state.selectedEntryIndex = state.visibleEntries.length - 1;
      }
      const selectedRowIndex = entryToRowIndex[state.selectedEntryIndex] ?? 0;
      entriesList.select(selectedRowIndex);
    }

    const dirtyText = state.hasUnsavedChanges ? '{yellow-fg}yes{/yellow-fg}' : '{green-fg}no{/green-fg}';
    const selectedFilePath = path.join(state.configPath, doc.title);
    statusBar.setContent(
      [
        `Path: ${selectedFilePath}`,
        `Keys: Enter Edit | a Add | d Delete | i Insert | m Move | / Search | n/N Jump | s Save | q Quit | Unsaved: ${dirtyText}`,
      ].join('\n'),
    );

    if (state.focusPane === 'files') {
      filesList.focus();
    } else if (state.focusPane === 'entries') {
      entriesList.focus();
    } else {
      referenceBox.focus();
    }

    screen.render();
  };

  // ---- helpers ----
  const withDialogLock = (fn: () => Promise<void>) => {
    if (state.dialogLock) return;
    state.dialogLock = true;
    fn().finally(() => {
      state.dialogLock = false;
    });
  };

  const ctx: ActionContext = { state, widgets, refreshUi };

  const syncDocumentSelectionFromFilesList = () => {
    const listIndex = getListSelected(filesList);
    if (listIndex < 0 || listIndex >= state.documents.length) return;
    if (listIndex !== state.selectedDocumentIndex) {
      state.selectedDocumentIndex = listIndex;
      state.selectedEntryIndex = 0;
      referenceBox.setScroll(0);
      state.statusMessage = `Switched to ${state.documents[state.selectedDocumentIndex].title}.`;
      refreshUi();
    }
  };

  const syncEntrySelectionFromEntriesList = () => {
    const rowIndex = getListSelected(entriesList);
    if (rowIndex < 0 || rowIndex >= renderedRows.length) return;

    let mappedEntryIndex = renderedRows[rowIndex]?.entryIndex ?? -1;
    if (mappedEntryIndex < 0) {
      for (let i = rowIndex - 1; i >= 0; i--) {
        if (renderedRows[i].selectable) {
          mappedEntryIndex = renderedRows[i].entryIndex;
          break;
        }
      }
    }
    if (mappedEntryIndex < 0) {
      for (let i = rowIndex + 1; i < renderedRows.length; i++) {
        if (renderedRows[i].selectable) {
          mappedEntryIndex = renderedRows[i].entryIndex;
          break;
        }
      }
    }

    if (mappedEntryIndex < 0 || mappedEntryIndex >= state.visibleEntries.length) return;
    if (mappedEntryIndex !== state.selectedEntryIndex) {
      state.selectedEntryIndex = mappedEntryIndex;
      refreshUi();
    }
  };

  // ---- list events ----
  filesList.on('select', (_: unknown, index: number) => {
    if (index == null) return;
    state.selectedDocumentIndex = index;
    state.selectedEntryIndex = 0;
    referenceBox.setScroll(0);
    refreshUi();
  });

  entriesList.on('select', (_: unknown, index: number) => {
    if (index == null) return;
    syncEntrySelectionFromEntriesList();
  });

  const NAV_KEYS = ['up', 'down', 'k', 'j', 'pageup', 'pagedown', 'home', 'end'];

  entriesList.on('keypress', (_: unknown, key: { name?: string }) => {
    if (!key?.name || !NAV_KEYS.includes(key.name)) return;
    setTimeout(() => syncEntrySelectionFromEntriesList(), 0);
  });

  filesList.on('keypress', (_: unknown, key: { name?: string }) => {
    if (!key?.name || !NAV_KEYS.includes(key.name)) return;
    setTimeout(() => syncDocumentSelectionFromFilesList(), 0);
  });

  // ---- guarded key helpers ----
  const guardedKey = (keys: string[], fn: () => void) => {
    screen.key(keys, () => {
      if (!state.dialogLock) fn();
    });
  };

  const guardedKeyAsync = (keys: string[], fn: () => Promise<void>) => {
    screen.key(keys, () => {
      if (!state.dialogLock) withDialogLock(fn);
    });
  };

  // ---- key bindings ----
  guardedKey(['tab'], () => {
    state.focusPane = state.focusPane === 'files' ? 'entries' : state.focusPane === 'entries' ? 'reference' : 'files';
    refreshUi();
  });

  guardedKey(['left', 'h'], () => {
    if (state.focusPane === 'entries') {
      state.focusPane = 'files';
      refreshUi();
      return;
    }
    if (state.focusPane === 'reference') {
      state.focusPane = 'entries';
      refreshUi();
    }
  });

  guardedKey(['right', 'l'], () => {
    if (state.focusPane === 'files') {
      state.focusPane = 'entries';
      refreshUi();
      return;
    }
    if (state.focusPane === 'entries') {
      state.focusPane = 'reference';
      refreshUi();
    }
  });

  guardedKey(['s'], () => saveAndExit(ctx));

  guardedKeyAsync(['q', 'C-c', 'escape'], () => quitFlow(ctx));

  guardedKeyAsync(['enter'], () => {
    syncEntrySelectionFromEntriesList();
    return editCurrentEntry(ctx);
  });

  guardedKeyAsync(['/'], () => searchEntries(ctx));

  guardedKeyAsync(['a'], () => {
    syncEntrySelectionFromEntriesList();
    return addEntry(ctx);
  });

  guardedKeyAsync(['d'], () => {
    syncEntrySelectionFromEntriesList();
    return deleteEntry(ctx);
  });

  guardedKeyAsync(['i'], () => {
    syncEntrySelectionFromEntriesList();
    return insertArrayEntry(ctx);
  });

  guardedKeyAsync(['m'], () => {
    syncEntrySelectionFromEntriesList();
    return moveArrayEntry(ctx);
  });

  guardedKey(['n'], () => jumpSearchMatch(ctx, 'next'));
  guardedKey(['N'], () => jumpSearchMatch(ctx, 'prev'));

  // ---- start ----
  refreshUi();

  return new Promise<boolean>((resolve) => {
    screen.once('destroy', () => resolve(state.didSave));
  });
}
