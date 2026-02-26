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
  let statusMessage = 'Tab switch focus | Enter edit | s save | / search (next phase) | q quit';

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

  const refreshUi = () => {
    const fileItems = documents.map((document) => document.title);
    filesList.setItems(fileItems);
    filesList.select(selectedDocumentIndex);

    const selectedDocument = documents[selectedDocumentIndex];
    const entries = editor.getEntriesForDocument(selectedDocument.id);
    const entryLines = entries.map(formatEntryLine);
    entriesList.setItems(entryLines);

    if (entries.length === 0) {
      selectedEntryIndex = 0;
      detailsBox.setContent('{yellow-fg}No keys found in selected document.{/yellow-fg}');
    } else {
      if (selectedEntryIndex >= entries.length) {
        selectedEntryIndex = entries.length - 1;
      }
      entriesList.select(selectedEntryIndex);

      const selectedEntry = entries[selectedEntryIndex];
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
        `Focus: ${focusPane} | Unsaved: ${dirtyText}`,
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
    const entries = editor.getEntriesForDocument(selectedDocument.id);
    if (entries.length === 0) {
      return;
    }

    const selectedEntry = entries[selectedEntryIndex];
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

  refreshUi();

  return new Promise<boolean>((resolve) => {
    screen.once('destroy', () => {
      resolve(didSave);
    });
  });
}
