import blessed, { Widgets } from 'blessed';
import { DevnetConfigEditor, TomlEntry } from '../node/devnet-config-editor';

type FocusPane = 'files' | 'entries';

function formatEntryLine(entry: TomlEntry): string {
  const depth = Math.max(0, entry.path.length - 1);
  const lastPathPart = entry.path[entry.path.length - 1] ?? '';
  const nodeName = /^\d+$/.test(lastPathPart) ? `[${lastPathPart}]` : lastPathPart;
  const indent = '  '.repeat(depth);

  if (entry.type === 'object') {
    return `${indent}▸ ${nodeName} ${entry.valuePreview}`;
  }

  if (entry.type === 'array') {
    return `${indent}▾ ${nodeName} ${entry.valuePreview}`;
  }

  return `${indent}  ${nodeName} = ${entry.valuePreview}`;
}

function waitForInput(
  screen: Widgets.Screen,
  title: string,
  questionText: string,
  initialValue: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = blessed.box({
      parent: screen,
      label: ` ${title} `,
      border: 'line',
      top: 'center',
      left: 'center',
      width: '70%',
      height: 13,
      keys: true,
      tags: true,
      style: {
        border: { fg: 'cyan' },
      },
    });

    blessed.box({
      parent: dialog,
      top: 1,
      left: 2,
      width: '95%-4',
      height: 2,
      tags: true,
      content: questionText,
    });

    const input = blessed.textbox({
      parent: dialog,
      top: 3,
      left: 2,
      width: '100%-4',
      height: 3,
      border: 'line',
      inputOnFocus: true,
      keys: true,
      vi: true,
      style: {
        border: { fg: 'gray' },
      },
    });

    const okButton = blessed.button({
      parent: dialog,
      mouse: true,
      keys: true,
      shrink: true,
      top: 8,
      left: '40%-8',
      height: 1,
      content: '  OK  ',
      style: {
        bg: 'blue',
        focus: { bg: 'blue' },
      },
    });

    const cancelButton = blessed.button({
      parent: dialog,
      mouse: true,
      keys: true,
      shrink: true,
      top: 8,
      left: '40%+4',
      height: 1,
      content: ' Cancel ',
      style: {
        bg: 'gray',
        focus: { bg: 'gray' },
      },
    });

    type InputDialogFocus = 'input' | 'ok' | 'cancel';
    let currentFocus: InputDialogFocus = 'input';

    const cleanup = (value: string | null) => {
      dialog.destroy();
      screen.render();
      resolve(value);
    };

    const setFocus = (nextFocus: InputDialogFocus) => {
      currentFocus = nextFocus;
      if (nextFocus === 'input') {
        input.style.border = { fg: 'cyan' };
        okButton.style.bg = 'blue';
        cancelButton.style.bg = 'gray';
        input.focus();
      } else if (nextFocus === 'ok') {
        input.style.border = { fg: 'gray' };
        okButton.style.bg = 'cyan';
        cancelButton.style.bg = 'gray';
        okButton.focus();
      } else {
        input.style.border = { fg: 'gray' };
        okButton.style.bg = 'blue';
        cancelButton.style.bg = 'cyan';
        cancelButton.focus();
      }
      screen.render();
    };

    const nextFocus = () => {
      if (currentFocus === 'input') {
        setFocus('ok');
        return;
      }
      if (currentFocus === 'ok') {
        setFocus('cancel');
        return;
      }
      setFocus('input');
    };

    const prevFocus = () => {
      if (currentFocus === 'cancel') {
        setFocus('ok');
        return;
      }
      if (currentFocus === 'ok') {
        setFocus('input');
        return;
      }
      setFocus('cancel');
    };

    const getInputValue = () => input.getValue() ?? '';

    okButton.on('press', () => cleanup(getInputValue()));
    cancelButton.on('press', () => cleanup(null));

    dialog.key(['escape'], () => cleanup(null));
    dialog.key(['tab', 'down'], () => nextFocus());
    dialog.key(['S-tab', 'up'], () => prevFocus());
    dialog.key(['left'], () => {
      if (currentFocus !== 'input') {
        prevFocus();
      }
    });
    dialog.key(['right'], () => {
      if (currentFocus !== 'input') {
        nextFocus();
      }
    });
    dialog.key(['enter'], () => {
      if (currentFocus === 'input') {
        setFocus('ok');
        return;
      }
      if (currentFocus === 'ok') {
        cleanup(getInputValue());
        return;
      }
      cleanup(null);
    });

    input.key(['enter'], () => {
      setFocus('ok');
    });

    input.setValue(initialValue);
    setFocus('input');
    input.readInput();
    screen.render();
  });
}

function waitForConfirm(
  screen: Widgets.Screen,
  title: string,
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = blessed.box({
      parent: screen,
      label: ` ${title} `,
      border: 'line',
      top: 'center',
      left: 'center',
      width: '60%',
      height: 10,
      keys: true,
      tags: true,
      style: {
        border: { fg: 'cyan' },
      },
    });

    blessed.box({
      parent: dialog,
      top: 2,
      left: 2,
      width: '100%-4',
      height: 2,
      tags: true,
      content: text,
    });

    const okButton = blessed.button({
      parent: dialog,
      mouse: true,
      keys: true,
      shrink: true,
      top: 5,
      left: '40%-8',
      height: 1,
      content: '  OK  ',
      style: {
        bg: 'blue',
        focus: { bg: 'blue' },
      },
    });

    const cancelButton = blessed.button({
      parent: dialog,
      mouse: true,
      keys: true,
      shrink: true,
      top: 5,
      left: '40%+4',
      height: 1,
      content: ' Cancel ',
      style: {
        bg: 'gray',
        focus: { bg: 'gray' },
      },
    });

    let focusButton: 'ok' | 'cancel' = 'cancel';

    const cleanup = (answer: boolean) => {
      dialog.destroy();
      screen.render();
      resolve(answer);
    };

    const setFocus = (focus: 'ok' | 'cancel') => {
      focusButton = focus;
      if (focus === 'ok') {
        okButton.style.bg = 'cyan';
        cancelButton.style.bg = 'gray';
        okButton.focus();
      } else {
        okButton.style.bg = 'blue';
        cancelButton.style.bg = 'cyan';
        cancelButton.focus();
      }
      screen.render();
    };

    okButton.on('press', () => cleanup(true));
    cancelButton.on('press', () => cleanup(false));

    dialog.key(['escape'], () => cleanup(false));
    dialog.key(['tab', 'left', 'right'], () => {
      setFocus(focusButton === 'ok' ? 'cancel' : 'ok');
    });
    dialog.key(['enter'], () => {
      cleanup(focusButton === 'ok');
    });

    setFocus('cancel');
    screen.render();
  });
}

export async function runDevnetConfigTui(editor: DevnetConfigEditor, configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a TTY terminal.');
  }

  const documents = editor.getDocuments();
  let selectedDocumentIndex = 0;
  let selectedEntryIndex = 0;
  let focusPane: FocusPane = 'files';
  let hasUnsavedChanges = false;
  let didSave = false;
  let searchTerm = '';
  let statusMessage = 'Ready';
  let visibleEntries: TomlEntry[] = [];

  const screen = blessed.screen({
    smartCSR: true,
    title: 'OffCKB Devnet Config Editor',
    fullUnicode: true,
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
    style: {
      selected: { bg: 'blue' },
      border: { fg: 'gray' },
    },
    tags: true,
  });

  const entriesList = blessed.list({
    parent: screen,
    label: ' Keys ',
    top: 0,
    left: '22%',
    width: '43%',
    height: '90%',
    border: 'line',
    keys: true,
    vi: true,
    style: {
      selected: { bg: 'blue' },
      border: { fg: 'gray' },
    },
    tags: true,
  });

  const detailsBox = blessed.box({
    parent: screen,
    label: ' Value / Details ',
    top: 0,
    left: '65%',
    width: '35%',
    height: '90%',
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: 'gray' },
    },
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
    style: {
      border: { fg: 'gray' },
    },
  });

  const getVisibleEntries = (entries: TomlEntry[]): TomlEntry[] => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) {
      return entries;
    }
    return entries.filter((entry) => {
      const text = `${entry.pathText} ${entry.valuePreview} ${entry.type}`.toLowerCase();
      return text.includes(term);
    });
  };

  const refreshUi = () => {
    const fileItems = documents.map((document) => document.title);
    filesList.setItems(fileItems);
    filesList.select(selectedDocumentIndex);

    const selectedDocument = documents[selectedDocumentIndex];
    const entries = editor.getEntriesForDocument(selectedDocument.id);
    visibleEntries = getVisibleEntries(entries);
    const entryLines = visibleEntries.map(formatEntryLine);
    entriesList.setItems(entryLines);

    filesList.style.border = { fg: focusPane === 'files' ? 'cyan' : 'gray' };
    entriesList.style.border = { fg: focusPane === 'entries' ? 'cyan' : 'gray' };
    detailsBox.style.border = { fg: 'gray' };

    if (visibleEntries.length === 0) {
      selectedEntryIndex = 0;
      detailsBox.setContent(
        searchTerm
          ? '{yellow-fg}No keys match search filter.{/yellow-fg}'
          : '{yellow-fg}No keys found in selected document.{/yellow-fg}',
      );
    } else {
      if (selectedEntryIndex >= visibleEntries.length) {
        selectedEntryIndex = visibleEntries.length - 1;
      }
      entriesList.select(selectedEntryIndex);

      const selectedEntry = visibleEntries[selectedEntryIndex];
      const rawValue = editor.getEntryValue(selectedEntry.documentId, selectedEntry.path);
      const valueText = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue, null, 2);

      detailsBox.setContent(
        [
          `{bold}File{/bold}: ${selectedDocument.title}`,
          `{bold}Path{/bold}: ${selectedEntry.pathText}`,
          `{bold}Type{/bold}: ${selectedEntry.type}`,
          `{bold}Editable{/bold}: ${selectedEntry.editable ? 'yes' : 'no'}`,
          '',
          '{bold}Current Value{/bold}',
          valueText ?? 'null',
        ].join('\n'),
      );
    }

    const dirtyText = hasUnsavedChanges ? '{yellow-fg}yes{/yellow-fg}' : '{green-fg}no{/green-fg}';
    statusBar.setContent(
      [
        `Path: ${configPath}`,
        `File: ${documents[selectedDocumentIndex].title} | Focus: ${focusPane} | Search: ${searchTerm || '(none)'} | Unsaved: ${dirtyText}`,
        `Status: ${statusMessage}`,
      ].join('\n'),
    );

    if (focusPane === 'files') {
      filesList.focus();
    } else {
      entriesList.focus();
    }

    screen.render();
  };

  const parseNonNegativeInteger = (value: string, fieldName: string): number => {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`${fieldName} must be a non-negative integer.`);
    }
    return parsed;
  };

  const resolveArrayTarget = (
    selectedEntry: TomlEntry,
  ): { arrayPath: string[]; suggestedIndex: number | null } | null => {
    if (selectedEntry.type === 'array') {
      return { arrayPath: selectedEntry.path, suggestedIndex: null };
    }

    const lastPart = selectedEntry.path[selectedEntry.path.length - 1];
    const parsedIndex = Number(lastPart);
    if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
      return { arrayPath: selectedEntry.path.slice(0, -1), suggestedIndex: parsedIndex };
    }

    return null;
  };

  const saveAndExit = () => {
    editor.save();
    hasUnsavedChanges = false;
    didSave = true;
    statusMessage = 'Saved.';
    screen.destroy();
  };

  const quitFlow = async () => {
    if (!hasUnsavedChanges) {
      screen.destroy();
      return;
    }

    const shouldDiscard = await waitForConfirm(screen, 'Discard Changes', 'Discard unsaved changes?');
    if (shouldDiscard) {
      screen.destroy();
      return;
    }

    statusMessage = 'Continue editing.';
    refreshUi();
  };

  const editCurrentEntry = async () => {
    if (focusPane === 'files') {
      focusPane = 'entries';
      refreshUi();
      return;
    }

    const selectedDocument = documents[selectedDocumentIndex];
    if (visibleEntries.length === 0) {
      return;
    }

    const selectedEntry = visibleEntries[selectedEntryIndex];
    if (!selectedEntry.editable) {
      statusMessage = `Path ${selectedEntry.pathText} is not primitive-editable yet.`;
      refreshUi();
      return;
    }

    const value = editor.getEntryValue(selectedEntry.documentId, selectedEntry.path);
    const valueText = value == null ? '' : String(value);
    const answer = await waitForInput(screen, 'Edit Value', selectedEntry.pathText, valueText);
    if (answer == null) {
      statusMessage = 'Edit canceled.';
      refreshUi();
      return;
    }

    try {
      editor.setDocumentValue(selectedEntry.documentId, selectedEntry.path, answer);
      hasUnsavedChanges = true;
      statusMessage = `Updated ${selectedEntry.pathText}.`;
    } catch (error) {
      statusMessage = `Validation error: ${(error as Error).message}`;
    }

    refreshUi();
  };

  const searchEntries = async () => {
    const answer = await waitForInput(
      screen,
      'Search',
      'Path/type/value filter (empty clears):',
      searchTerm,
    );
    if (answer == null) {
      statusMessage = 'Search canceled.';
      refreshUi();
      return;
    }

    searchTerm = answer.trim();
    selectedEntryIndex = 0;
    statusMessage = searchTerm ? `Filter applied: ${searchTerm}` : 'Search filter cleared.';
    refreshUi();
  };

  const jumpSearchMatch = (direction: 'next' | 'prev') => {
    if (visibleEntries.length === 0) {
      statusMessage = searchTerm ? 'No search matches to jump.' : 'Set search filter first with /.';
      refreshUi();
      return;
    }

    if (direction === 'next') {
      selectedEntryIndex = (selectedEntryIndex + 1) % visibleEntries.length;
      statusMessage = `Jumped to next match (${selectedEntryIndex + 1}/${visibleEntries.length}).`;
    } else {
      selectedEntryIndex = (selectedEntryIndex - 1 + visibleEntries.length) % visibleEntries.length;
      statusMessage = `Jumped to previous match (${selectedEntryIndex + 1}/${visibleEntries.length}).`;
    }

    refreshUi();
  };

  const addEntry = async () => {
    const selectedDocument = documents[selectedDocumentIndex];

    const targetEntry =
      visibleEntries.length > 0 ? visibleEntries[Math.min(selectedEntryIndex, visibleEntries.length - 1)] : null;

    const targetPath = targetEntry?.path ?? [];
    const targetValue = editor.getEntryValue(selectedDocument.id, targetPath);

    if (targetEntry == null && !Array.isArray(targetValue) && (targetValue == null || typeof targetValue !== 'object')) {
      statusMessage = 'No target object/array selected for add.';
      refreshUi();
      return;
    }

    if (targetEntry?.type === 'object' || (targetEntry == null && targetValue != null && typeof targetValue === 'object')) {
      const keyAnswer = await waitForInput(screen, 'Add Object Key', 'New key name:', '');
      if (keyAnswer == null) {
        statusMessage = 'Add canceled.';
        refreshUi();
        return;
      }

      const valueAnswer = await waitForInput(
        screen,
        'Add Object Key',
        `Value for ${keyAnswer.trim()} (auto parse bool/number):`,
        '',
      );
      if (valueAnswer == null) {
        statusMessage = 'Add canceled.';
        refreshUi();
        return;
      }

      try {
        editor.addObjectEntry(selectedDocument.id, targetPath, keyAnswer, valueAnswer);
        hasUnsavedChanges = true;
        statusMessage = `Added key '${keyAnswer.trim()}' under ${targetPath.join('.') || '<root>'}.`;
      } catch (error) {
        statusMessage = `Add failed: ${(error as Error).message}`;
      }
      refreshUi();
      return;
    }

    if (targetEntry?.type === 'array') {
      const valueAnswer = await waitForInput(screen, 'Append Array Item', `Append value to ${targetEntry.pathText}:`, '');
      if (valueAnswer == null) {
        statusMessage = 'Append canceled.';
        refreshUi();
        return;
      }

      try {
        editor.appendArrayEntry(selectedDocument.id, targetEntry.path, valueAnswer);
        hasUnsavedChanges = true;
        statusMessage = `Appended value to ${targetEntry.pathText}.`;
      } catch (error) {
        statusMessage = `Append failed: ${(error as Error).message}`;
      }
      refreshUi();
      return;
    }

    statusMessage = 'Select an object or array node to add items.';
    refreshUi();
  };

  const insertArrayEntry = async () => {
    if (visibleEntries.length === 0) {
      statusMessage = 'No selected entry for insert.';
      refreshUi();
      return;
    }

    const selectedDocument = documents[selectedDocumentIndex];
    const selectedEntry = visibleEntries[selectedEntryIndex];
    const target = resolveArrayTarget(selectedEntry);
    if (target == null) {
      statusMessage = 'Select an array or array item to insert.';
      refreshUi();
      return;
    }

    const arrayValue = editor.getEntryValue(selectedDocument.id, target.arrayPath);
    const arrayLength = Array.isArray(arrayValue) ? arrayValue.length : 0;
    const indexAnswer = await waitForInput(
      screen,
      'Insert Array Item',
      `Insert index (0-${arrayLength}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
      target.suggestedIndex != null ? String(target.suggestedIndex) : String(arrayLength),
    );
    if (indexAnswer == null) {
      statusMessage = 'Insert canceled.';
      refreshUi();
      return;
    }

    const valueAnswer = await waitForInput(
      screen,
      'Insert Array Item',
      `Value to insert at ${target.arrayPath.join('.')} (auto parse bool/number):`,
      '',
    );
    if (valueAnswer == null) {
      statusMessage = 'Insert canceled.';
      refreshUi();
      return;
    }

    try {
      const indexInput = indexAnswer.trim();
      const insertIndex =
        indexInput === '' && target.suggestedIndex != null
          ? target.suggestedIndex
          : parseNonNegativeInteger(indexAnswer, 'Insert index');

      editor.insertArrayEntry(selectedDocument.id, target.arrayPath, insertIndex, valueAnswer);
      hasUnsavedChanges = true;
      statusMessage = `Inserted array item at ${target.arrayPath.join('.')}[${insertIndex}].`;
    } catch (error) {
      statusMessage = `Insert failed: ${(error as Error).message}`;
    }

    refreshUi();
  };

  const moveArrayEntry = async () => {
    if (visibleEntries.length === 0) {
      statusMessage = 'No selected entry for move.';
      refreshUi();
      return;
    }

    const selectedDocument = documents[selectedDocumentIndex];
    const selectedEntry = visibleEntries[selectedEntryIndex];
    const target = resolveArrayTarget(selectedEntry);
    if (target == null) {
      statusMessage = 'Select an array or array item to move.';
      refreshUi();
      return;
    }

    const arrayValue = editor.getEntryValue(selectedDocument.id, target.arrayPath);
    const arrayLength = Array.isArray(arrayValue) ? arrayValue.length : 0;

    const fromAnswer = await waitForInput(
      screen,
      'Move Array Item',
      `Move from index (0-${Math.max(0, arrayLength - 1)}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
      target.suggestedIndex != null ? String(target.suggestedIndex) : '0',
    );
    if (fromAnswer == null) {
      statusMessage = 'Move canceled.';
      refreshUi();
      return;
    }

    const toAnswer = await waitForInput(
      screen,
      'Move Array Item',
      `Move to index (0-${Math.max(0, arrayLength - 1)}):`,
      '0',
    );
    if (toAnswer == null) {
      statusMessage = 'Move canceled.';
      refreshUi();
      return;
    }

    try {
      const fromInput = fromAnswer.trim();
      const fromIndex =
        fromInput === '' && target.suggestedIndex != null
          ? target.suggestedIndex
          : parseNonNegativeInteger(fromAnswer, 'Source index');
      const toIndex = parseNonNegativeInteger(toAnswer, 'Target index');

      editor.moveArrayEntry(selectedDocument.id, target.arrayPath, fromIndex, toIndex);
      hasUnsavedChanges = true;
      statusMessage = `Moved item in ${target.arrayPath.join('.')} from ${fromIndex} to ${toIndex}.`;
    } catch (error) {
      statusMessage = `Move failed: ${(error as Error).message}`;
    }

    refreshUi();
  };

  const deleteEntry = async () => {
    const selectedDocument = documents[selectedDocumentIndex];
    if (visibleEntries.length === 0) {
      statusMessage = 'No selected entry to delete.';
      refreshUi();
      return;
    }

    const selectedEntry = visibleEntries[selectedEntryIndex];
    const confirmed = await waitForConfirm(screen, 'Delete Path', `Delete ${selectedEntry.pathText}?`);
    if (!confirmed) {
      statusMessage = 'Delete canceled.';
      refreshUi();
      return;
    }

    try {
      editor.deleteDocumentPath(selectedDocument.id, selectedEntry.path);
      hasUnsavedChanges = true;
      selectedEntryIndex = Math.max(0, selectedEntryIndex - 1);
      statusMessage = `Deleted ${selectedEntry.pathText}.`;
    } catch (error) {
      statusMessage = `Delete failed: ${(error as Error).message}`;
    }
    refreshUi();
  };

  const syncDocumentSelectionFromFilesList = () => {
    const listIndex = (filesList as unknown as { selected?: number }).selected;
    if (listIndex == null || listIndex < 0 || listIndex >= documents.length) {
      return;
    }
    if (listIndex !== selectedDocumentIndex) {
      selectedDocumentIndex = listIndex;
      selectedEntryIndex = 0;
      statusMessage = `Switched to ${documents[selectedDocumentIndex].title}.`;
      refreshUi();
    }
  };

  filesList.on('select', (_, index) => {
    if (index == null) {
      return;
    }
    selectedDocumentIndex = index;
    selectedEntryIndex = 0;
    refreshUi();
  });

  entriesList.on('select', (_, index) => {
    if (index == null) {
      return;
    }
    selectedEntryIndex = index;
    refreshUi();
  });

  filesList.on('keypress', (_, key) => {
    const navKeys = ['up', 'down', 'k', 'j', 'pageup', 'pagedown', 'home', 'end'];
    if (!key?.name || !navKeys.includes(key.name)) {
      return;
    }

    setTimeout(() => {
      syncDocumentSelectionFromFilesList();
    }, 0);
  });

  screen.key(['tab'], () => {
    focusPane = focusPane === 'files' ? 'entries' : 'files';
    refreshUi();
  });

  screen.key(['left', 'h'], () => {
    if (focusPane === 'entries') {
      focusPane = 'files';
      refreshUi();
    }
  });

  screen.key(['right', 'l'], () => {
    if (focusPane === 'files') {
      focusPane = 'entries';
      refreshUi();
    }
  });

  screen.key(['s'], () => {
    saveAndExit();
  });

  screen.key(['q', 'C-c'], () => {
    void quitFlow();
  });

  screen.key(['enter'], () => {
    void editCurrentEntry();
  });

  screen.key(['/'], () => {
    void searchEntries();
  });

  screen.key(['a'], () => {
    void addEntry();
  });

  screen.key(['d'], () => {
    void deleteEntry();
  });

  screen.key(['i'], () => {
    void insertArrayEntry();
  });

  screen.key(['m'], () => {
    void moveArrayEntry();
  });

  screen.key(['n'], () => {
    jumpSearchMatch('next');
  });

  screen.key(['N'], () => {
    jumpSearchMatch('prev');
  });

  filesList.key(['enter'], () => {
    focusPane = 'entries';
    refreshUi();
  });

  refreshUi();

  return new Promise<boolean>((resolve) => {
    screen.once('destroy', () => {
      resolve(didSave);
    });
  });
}
