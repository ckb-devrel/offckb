import blessed, { Widgets } from 'blessed';
import { FixedArraySpec } from './devnet-config-metadata';
import { getListSelected } from './blessed-helpers';

// ---------------------------------------------------------------------------
// Fixed-array multi-select dialog
// ---------------------------------------------------------------------------

export async function waitForFixedArraySelection(
  screen: Widgets.Screen,
  title: string,
  spec: FixedArraySpec,
  currentValues: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const maxVisibleRows = 14;
    const visibleRows = Math.min(Math.max(spec.options.length, 1), maxVisibleRows);
    const listHeight = visibleRows + 2;
    const dialogHeight = listHeight + 6;

    const overlay = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      mouse: true,
      keys: true,
      tags: true,
    });

    const dialog = blessed.box({
      parent: overlay,
      label: ` ${title} `,
      border: 'line',
      top: 'center',
      left: 'center',
      width: '62%',
      height: dialogHeight,
      mouse: true,
      keys: true,
      tags: true,
      style: { border: { fg: 'cyan' } },
    });

    const selectedValues = new Set(currentValues);

    const list = blessed.list({
      parent: dialog,
      top: 1,
      left: 1,
      width: '100%-2',
      height: listHeight,
      border: 'line',
      mouse: true,
      keys: true,
      vi: true,
      tags: true,
      style: {
        selected: { bg: 'blue' },
        border: { fg: 'gray' },
      },
    });

    blessed.box({
      parent: dialog,
      top: listHeight + 1,
      left: 2,
      width: '100%-4',
      height: 2,
      tags: true,
      content: '{gray-fg}Space toggle  Enter apply  Esc cancel  Alt+a all  Alt+d none{/gray-fg}',
    });

    const renderList = () => {
      const items = spec.options.map((option) => {
        const checked = selectedValues.has(option) ? 'x' : ' ';
        return `[${checked}] ${option}`;
      });
      list.setItems(items);
    };

    renderList();
    list.select(0);

    const screenWithGrab = screen as unknown as { grabKeys?: boolean; grabMouse?: boolean };
    const previousGrabKeys = screenWithGrab.grabKeys;
    const previousGrabMouse = screenWithGrab.grabMouse;
    screenWithGrab.grabKeys = true;
    screenWithGrab.grabMouse = true;

    let resolved = false;
    const cleanup = (value: string[] | null) => {
      if (resolved) return;
      resolved = true;
      screenWithGrab.grabKeys = previousGrabKeys;
      screenWithGrab.grabMouse = previousGrabMouse;
      overlay.destroy();
      screen.render();
      resolve(value);
    };

    const selectedOption = () => {
      const selectedIndex = getListSelected(list);
      return spec.options[selectedIndex] ?? null;
    };

    const applySelection = () => {
      const values = spec.options.filter((option) => selectedValues.has(option));
      cleanup(values);
    };

    const toggleSelectedOption = () => {
      const option = selectedOption();
      if (option == null) return;

      if (selectedValues.has(option)) {
        selectedValues.delete(option);
      } else {
        selectedValues.add(option);
      }
      renderList();
      list.select(getListSelected(list));
      screen.render();
    };

    list.key(['enter'], () => applySelection());
    list.key(['up', 'k'], () => { list.up(1); screen.render(); });
    list.key(['down', 'j'], () => { list.down(1); screen.render(); });
    list.key(['space'], () => toggleSelectedOption());

    dialog.key(['escape'], () => cleanup(null));
    dialog.key(['A-a'], () => {
      spec.options.forEach((option) => selectedValues.add(option));
      renderList();
      screen.render();
    });
    dialog.key(['A-d'], () => {
      selectedValues.clear();
      renderList();
      screen.render();
    });

    list.focus();
    screen.render();
  });
}

// ---------------------------------------------------------------------------
// Text input dialog
// ---------------------------------------------------------------------------

export function waitForInput(
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
      style: { border: { fg: 'cyan' } },
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
      style: { border: { fg: 'gray' } },
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
      style: { bg: 'blue', focus: { bg: 'blue' } },
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
      style: { bg: 'gray', focus: { bg: 'gray' } },
    });

    type InputDialogFocus = 'input' | 'ok' | 'cancel';
    let currentFocus: InputDialogFocus = 'input';

    let resolved = false;
    const cleanup = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      dialog.destroy();
      screen.render();
      resolve(value);
    };

    const setFocus = (nextFocus: InputDialogFocus) => {
      if (resolved) return;
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
      if (currentFocus === 'input') { setFocus('ok'); return; }
      if (currentFocus === 'ok') { setFocus('cancel'); return; }
      setFocus('input');
    };

    const prevFocus = () => {
      if (currentFocus === 'cancel') { setFocus('ok'); return; }
      if (currentFocus === 'ok') { setFocus('input'); return; }
      setFocus('cancel');
    };

    const getInputValue = () => input.getValue() ?? '';

    okButton.on('press', () => cleanup(getInputValue()));
    cancelButton.on('press', () => cleanup(null));

    dialog.key(['escape'], () => cleanup(null));
    dialog.key(['tab', 'down'], () => nextFocus());
    dialog.key(['S-tab', 'up'], () => prevFocus());
    dialog.key(['left'], () => { if (currentFocus !== 'input') prevFocus(); });
    dialog.key(['right'], () => { if (currentFocus !== 'input') nextFocus(); });
    dialog.key(['enter'], () => {
      if (currentFocus === 'input') { cleanup(getInputValue()); return; }
      if (currentFocus === 'ok') { cleanup(getInputValue()); return; }
      cleanup(null);
    });

    input.key(['enter'], () => cleanup(getInputValue()));

    input.setValue(initialValue);
    setFocus('input');
    input.readInput();
    screen.render();
  });
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

export function waitForConfirm(
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
      style: { border: { fg: 'cyan' } },
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
      style: { bg: 'blue', focus: { bg: 'blue' } },
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
      style: { bg: 'gray', focus: { bg: 'gray' } },
    });

    let focusButton: 'ok' | 'cancel' = 'cancel';

    let resolved = false;
    const cleanup = (answer: boolean) => {
      if (resolved) return;
      resolved = true;
      dialog.destroy();
      screen.render();
      resolve(answer);
    };

    const setFocus = (focus: 'ok' | 'cancel') => {
      if (resolved) return;
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
    dialog.key(['enter'], () => cleanup(focusButton === 'ok'));

    setFocus('cancel');
    screen.render();
  });
}

// ---------------------------------------------------------------------------
// Array-value input (routes to fixed-array dialog or text input)
// ---------------------------------------------------------------------------

export async function waitForArrayValue(
  screen: Widgets.Screen,
  spec: FixedArraySpec | null,
  title: string,
  questionText: string,
  initialValue: string,
): Promise<string | null> {
  if (spec == null) {
    return waitForInput(screen, title, questionText, initialValue);
  }

  if (spec.options.includes(initialValue)) {
    const selected = await waitForFixedArraySelection(screen, `${title} (${spec.label})`, spec, [initialValue]);
    if (selected == null || selected.length === 0) return null;
    return selected[0];
  }

  if (!spec.allowCustom) {
    const selected = await waitForFixedArraySelection(screen, `${title} (${spec.label})`, spec, []);
    if (selected == null || selected.length === 0) return null;
    return selected[0];
  }

  return waitForInput(screen, title, questionText, initialValue);
}
