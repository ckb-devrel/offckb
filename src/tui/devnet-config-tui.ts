import readline from 'node:readline';
import { DevnetConfigEditor } from '../node/devnet-config-editor';

const ansi = {
  clear: '\u001B[2J\u001B[H',
  hideCursor: '\u001B[?25l',
  showCursor: '\u001B[?25h',
  bold: '\u001B[1m',
  reset: '\u001B[0m',
};

function formatFieldValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runDevnetConfigTui(editor: DevnetConfigEditor, configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive TUI requires a TTY terminal.');
  }

  let selectedIndex = 0;
  let isSaved = false;
  let isDone = false;
  let statusMessage = 'Use ↑/↓ to navigate, Enter to edit, Space to toggle booleans, s to save, q to quit.';

  const initialFields = editor.getFields();
  const initialState = new Map(initialFields.map((field) => [field.id, field.value]));

  const hasChanges = () => {
    const current = editor.getFields();
    return current.some((field) => initialState.get(field.id) !== field.value);
  };

  const render = () => {
    const fields = editor.getFields();
    const lines: string[] = [];

    lines.push(`${ansi.bold}OffCKB Devnet Config Editor${ansi.reset}`);
    lines.push(`Path: ${configPath}`);
    lines.push('');

    lines.push(`${ansi.bold}Editable fields (safe subset)${ansi.reset}`);
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const marker = i === selectedIndex ? '›' : ' ';
      lines.push(`${marker} ${String(i + 1).padStart(2, '0')}. ${field.label}: ${formatFieldValue(field.value)}`);
      lines.push(`     ${field.description} (${field.id})`);
    }

    lines.push('');
    lines.push(`${ansi.bold}Keys${ansi.reset}: ↑/↓ move  Enter edit  Space toggle  s save  q quit  Ctrl+C quit`);
    lines.push(`Changes pending: ${hasChanges() ? 'yes' : 'no'}`);
    lines.push(`Status: ${statusMessage}`);

    process.stdout.write(`${ansi.clear}${ansi.hideCursor}${lines.join('\n')}\n`);
  };

  const setRawMode = (enabled: boolean) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(enabled);
    }
  };

  const cleanup = () => {
    process.stdin.off('keypress', onKeypress);
    setRawMode(false);
    process.stdout.write(`${ansi.showCursor}\n`);
  };

  const confirmDiscard = async (): Promise<boolean> => {
    setRawMode(false);
    process.stdout.write(`${ansi.showCursor}`);
    const answer = await askLine('Discard unsaved changes? [y/N]: ');
    setRawMode(true);
    process.stdout.write(ansi.hideCursor);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  };

  const editSelectedField = async () => {
    const selectedField = editor.getFields()[selectedIndex];

    if (selectedField.type === 'boolean') {
      const nextValue = editor.toggleBooleanField(selectedField.id);
      statusMessage = `${selectedField.label} updated to ${formatFieldValue(nextValue)}.`;
      return;
    }

    setRawMode(false);
    process.stdout.write(ansi.showCursor);
    const answer = await askLine(`${selectedField.label} (${formatFieldValue(selectedField.value)}): `);
    setRawMode(true);
    process.stdout.write(ansi.hideCursor);

    if (!answer.trim()) {
      statusMessage = 'No input provided, keeping current value.';
      return;
    }

    try {
      const nextValue = editor.setFieldValue(selectedField.id, answer);
      statusMessage = `${selectedField.label} updated to ${formatFieldValue(nextValue)}.`;
    } catch (error) {
      statusMessage = `Validation error: ${(error as Error).message}`;
    }
  };

  const onKeypress = async (_chunk: string, key: readline.Key) => {
    if (isDone) {
      return;
    }

    const fields = editor.getFields();

    if (key.ctrl && key.name === 'c') {
      if (hasChanges()) {
        const shouldDiscard = await confirmDiscard();
        if (!shouldDiscard) {
          statusMessage = 'Continue editing.';
          render();
          return;
        }
      }

      statusMessage = 'Canceled.';
      isDone = true;
      cleanup();
      return;
    }

    switch (key.name) {
      case 'up': {
        selectedIndex = selectedIndex === 0 ? fields.length - 1 : selectedIndex - 1;
        break;
      }
      case 'down': {
        selectedIndex = selectedIndex === fields.length - 1 ? 0 : selectedIndex + 1;
        break;
      }
      case 'return': {
        await editSelectedField();
        break;
      }
      case 'space': {
        const selectedField = fields[selectedIndex];
        if (selectedField.type !== 'boolean') {
          statusMessage = `Field ${selectedField.label} is not boolean.`;
        } else {
          const nextValue = editor.toggleBooleanField(selectedField.id);
          statusMessage = `${selectedField.label} updated to ${formatFieldValue(nextValue)}.`;
        }
        break;
      }
      default: {
        if (_chunk === 'k') {
          selectedIndex = selectedIndex === 0 ? fields.length - 1 : selectedIndex - 1;
        } else if (_chunk === 'j') {
          selectedIndex = selectedIndex === fields.length - 1 ? 0 : selectedIndex + 1;
        } else if (_chunk === 'e') {
          await editSelectedField();
        } else if (_chunk === 's') {
          editor.save();
          statusMessage = 'Saved.';
          isSaved = true;
          isDone = true;
          cleanup();
          return;
        } else if (_chunk === 'q') {
          if (hasChanges()) {
            const shouldDiscard = await confirmDiscard();
            if (!shouldDiscard) {
              statusMessage = 'Continue editing.';
              render();
              return;
            }
          }

          statusMessage = 'Canceled.';
          isDone = true;
          cleanup();
          return;
        }
        break;
      }
    }

    render();
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', onKeypress);
  setRawMode(true);
  render();

  while (!isDone) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return isSaved;
}
