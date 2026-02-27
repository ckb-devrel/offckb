import blessed from 'blessed';
import { DevnetConfigEditor, TomlEntry } from '../devnet/config-editor';
import { getConfigDoc, getFixedArraySpecFromEntryPath } from './devnet-config-metadata';
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
    width: '22%',
    height: '90%',
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
    left: '22%',
    width: '78%',
    height: '90%',
    border: 'line',
    keys: true,
    vi: true,
    style: { selected: { bg: 'blue' }, border: { fg: 'gray' } },
    tags: true,
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: '10%',
    border: 'line',
    tags: true,
    content: '',
    style: { border: { fg: 'gray' } },
  });

  const widgets: TuiWidgets = { screen, filesList, entriesList, statusBar };
  let renderedRows: EntryRenderRow[] = [];
  let entryToRowIndex: number[] = [];

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
    const selectedEntry = state.visibleEntries[state.selectedEntryIndex];
    const keyDoc = selectedEntry != null ? getConfigDoc(selectedEntry.path) : null;
    const docLine = keyDoc != null ? `${keyDoc.summary} (${keyDoc.source})` : 'No inline doc for this key yet.';
    statusBar.setContent(
      [
        `Path: ${state.configPath}`,
        `File: ${doc.title} | Focus: ${state.focusPane} | Search: ${state.searchTerm || '(none)'} | Unsaved: ${dirtyText}`,
        `Status: ${state.statusMessage}`,
        `Doc: ${docLine}`,
      ].join('\n'),
    );

    if (state.focusPane === 'files') {
      filesList.focus();
    } else {
      entriesList.focus();
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
    state.focusPane = state.focusPane === 'files' ? 'entries' : 'files';
    refreshUi();
  });

  guardedKey(['left', 'h'], () => {
    if (state.focusPane === 'entries') {
      state.focusPane = 'files';
      refreshUi();
    }
  });

  guardedKey(['right', 'l'], () => {
    if (state.focusPane === 'files') {
      state.focusPane = 'entries';
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

  filesList.key(['enter'], () => {
    if (state.dialogLock) return;
    state.focusPane = 'entries';
    refreshUi();
  });

  // ---- start ----
  refreshUi();

  return new Promise<boolean>((resolve) => {
    screen.once('destroy', () => resolve(state.didSave));
  });
}
