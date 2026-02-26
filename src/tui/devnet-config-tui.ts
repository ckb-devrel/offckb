import blessed, { Widgets } from 'blessed';
import { DevnetConfigEditor, TomlEntry } from '../node/devnet-config-editor';

type FocusPane = 'files' | 'entries';

function formatEntryLine(entry: TomlEntry): string {
  return `${entry.pathText} = ${entry.valuePreview}`;
}

function waitForQuestion(
  screen: Widgets.Screen,
  prompt: Widgets.PromptElement,
  questionText: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    prompt.input(questionText, '', (_error, value) => {
      screen.render();
      resolve(value == null ? null : value);
    });
  });
}

function waitForConfirm(
  screen: Widgets.Screen,
  question: Widgets.QuestionElement,
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    question.ask(text, (answer) => {
      screen.render();
      resolve(answer);
    });
  });
}

export async function runDevnetConfigTui(editor: DevnetConfigEditor, configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a TTY terminal.');
  }

  const documents = editor.getDocuments();
  let selectedDocumentIndex = 0;
  let selectedEntryIndex = 0;
  let focusPane: FocusPane = 'entries';
  let hasUnsavedChanges = false;
  let didSave = false;
  let searchTerm = '';
  let statusMessage = 'Tab focus | Enter edit | a add | i insert | m move | d delete | / search n/N | s save | q quit';
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

  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 9,
    width: '70%',
    top: 'center',
    left: 'center',
    label: ' Edit Value ',
    keys: true,
    vi: true,
    tags: true,
    hidden: true,
  });

  const question = blessed.question({
    parent: screen,
    border: 'line',
    height: 8,
    width: '60%',
    top: 'center',
    left: 'center',
    label: ' Confirm ',
    keys: true,
    vi: true,
    tags: true,
    hidden: true,
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
        `Focus: ${focusPane} | Search: ${searchTerm || '(none)'} | Unsaved: ${dirtyText}`,
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

    const shouldDiscard = await waitForConfirm(screen, question, 'Discard unsaved changes?');
    if (shouldDiscard) {
      screen.destroy();
      return;
    }

    statusMessage = 'Continue editing.';
    refreshUi();
  };

  const editCurrentEntry = async () => {
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
    const answer = await waitForQuestion(screen, prompt, `${selectedEntry.pathText} = ${valueText}`);
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
    const answer = await waitForQuestion(
      screen,
      prompt,
      `Search (path/type/value, empty to clear): ${searchTerm || ''}`,
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
      const keyAnswer = await waitForQuestion(screen, prompt, 'New key name:');
      if (keyAnswer == null) {
        statusMessage = 'Add canceled.';
        refreshUi();
        return;
      }

      const valueAnswer = await waitForQuestion(screen, prompt, `Value for ${keyAnswer.trim()} (auto parse bool/number):`);
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
      const valueAnswer = await waitForQuestion(screen, prompt, `Append value to ${targetEntry.pathText}:`);
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
    const indexAnswer = await waitForQuestion(
      screen,
      prompt,
      `Insert index (0-${arrayLength}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
    );
    if (indexAnswer == null) {
      statusMessage = 'Insert canceled.';
      refreshUi();
      return;
    }

    const valueAnswer = await waitForQuestion(
      screen,
      prompt,
      `Value to insert at ${target.arrayPath.join('.')} (auto parse bool/number):`,
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

    const fromAnswer = await waitForQuestion(
      screen,
      prompt,
      `Move from index (0-${Math.max(0, arrayLength - 1)}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
    );
    if (fromAnswer == null) {
      statusMessage = 'Move canceled.';
      refreshUi();
      return;
    }

    const toAnswer = await waitForQuestion(screen, prompt, `Move to index (0-${Math.max(0, arrayLength - 1)}):`);
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
    const confirmed = await waitForConfirm(screen, question, `Delete ${selectedEntry.pathText}?`);
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

  screen.key(['tab'], () => {
    focusPane = focusPane === 'files' ? 'entries' : 'files';
    refreshUi();
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

  refreshUi();

  return new Promise<boolean>((resolve) => {
    screen.once('destroy', () => {
      resolve(didSave);
    });
  });
}
