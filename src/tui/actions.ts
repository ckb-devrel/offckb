import { TomlEntry } from '../node/devnet-config-editor';
import { getFixedArraySpecFromEntryPath, FixedArraySpec } from './devnet-config-metadata';
import { waitForInput, waitForConfirm, waitForFixedArraySelection, waitForArrayValue } from './dialogs';
import { TuiState, TuiWidgets } from './tui-state';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseNonNegativeInteger(value: string, fieldName: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}

export function resolveArrayTarget(
  selectedEntry: TomlEntry,
): { arrayPath: string[]; suggestedIndex: number | null } | null {
  if (selectedEntry.type === 'array') {
    return { arrayPath: selectedEntry.path, suggestedIndex: null };
  }

  const lastPart = selectedEntry.path[selectedEntry.path.length - 1];
  const parsedIndex = Number(lastPart);
  if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
    return { arrayPath: selectedEntry.path.slice(0, -1), suggestedIndex: parsedIndex };
  }

  return null;
}

export function resolveFixedArrayTarget(
  selectedEntry: TomlEntry,
): { arrayPath: string[]; spec: FixedArraySpec } | null {
  const spec = getFixedArraySpecFromEntryPath(selectedEntry.path);
  if (spec == null) return null;

  if (selectedEntry.type === 'array') {
    return { arrayPath: selectedEntry.path, spec };
  }

  const lastPart = selectedEntry.path[selectedEntry.path.length - 1];
  if (/^\d+$/.test(lastPart)) {
    return { arrayPath: selectedEntry.path.slice(0, -1), spec };
  }

  return { arrayPath: selectedEntry.path, spec };
}

// ---------------------------------------------------------------------------
// Shared sub-action: edit a fixed-array via multi-select dialog
// ---------------------------------------------------------------------------

export async function editFixedArraySelection(
  state: TuiState,
  screen: import('blessed').Widgets.Screen,
  documentId: 'ckb' | 'miner',
  arrayPath: string[],
  spec: FixedArraySpec,
  refreshUi: () => void,
): Promise<void> {
  const rawArrayValue = state.editor.getEntryValue(documentId, arrayPath);
  if (!Array.isArray(rawArrayValue)) {
    state.statusMessage = `Path ${arrayPath.join('.')} is not an array.`;
    refreshUi();
    return;
  }

  const currentValues = rawArrayValue.map((item) => String(item));
  const selectedValues = await waitForFixedArraySelection(screen, `Edit ${spec.label}`, spec, currentValues);
  if (selectedValues == null) {
    state.statusMessage = 'Edit canceled.';
    refreshUi();
    return;
  }

  const nextValues = spec.unique ? Array.from(new Set(selectedValues)) : selectedValues;
  state.editor.setArrayValues(documentId, arrayPath, nextValues);
  state.hasUnsavedChanges = true;
  state.statusMessage = `Updated ${arrayPath.join('.')} (${nextValues.length} selected).`;
  refreshUi();
}

// ---------------------------------------------------------------------------
// Action context: common args passed to every action
// ---------------------------------------------------------------------------

export interface ActionContext {
  state: TuiState;
  widgets: TuiWidgets;
  refreshUi: () => void;
}

function currentDocument(ctx: ActionContext) {
  return ctx.state.documents[ctx.state.selectedDocumentIndex];
}

function currentEntry(ctx: ActionContext): TomlEntry | null {
  if (ctx.state.visibleEntries.length === 0) return null;
  return ctx.state.visibleEntries[ctx.state.selectedEntryIndex] ?? null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function editCurrentEntry(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;

  if (state.focusPane === 'files') {
    state.focusPane = 'entries';
    refreshUi();
    return;
  }

  const doc = currentDocument(ctx);
  const entry = currentEntry(ctx);
  if (entry == null) return;

  const fixedTarget = resolveFixedArrayTarget(entry);
  if (fixedTarget != null) {
    await editFixedArraySelection(state, widgets.screen, doc.id, fixedTarget.arrayPath, fixedTarget.spec, refreshUi);
    return;
  }

  if (!entry.editable) {
    state.statusMessage = `Path ${entry.pathText} is not primitive-editable yet.`;
    refreshUi();
    return;
  }

  const value = state.editor.getEntryValue(entry.documentId, entry.path);
  const valueText = value == null ? '' : String(value);
  const answer = await waitForArrayValue(widgets.screen, null, 'Edit Value', entry.pathText, valueText);
  if (answer == null) {
    state.statusMessage = 'Edit canceled.';
    refreshUi();
    return;
  }

  try {
    state.editor.setDocumentValue(entry.documentId, entry.path, answer);
    state.hasUnsavedChanges = true;
    state.statusMessage = `Updated ${entry.pathText}.`;
  } catch (error) {
    state.statusMessage = `Validation error: ${(error as Error).message}`;
  }

  refreshUi();
}

export async function searchEntries(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;

  const answer = await waitForInput(
    widgets.screen,
    'Search',
    'Path/type/value filter (empty clears):',
    state.searchTerm,
  );
  if (answer == null) {
    state.statusMessage = 'Search canceled.';
    refreshUi();
    return;
  }

  state.searchTerm = answer.trim();
  state.selectedEntryIndex = 0;
  state.statusMessage = state.searchTerm ? `Filter applied: ${state.searchTerm}` : 'Search filter cleared.';
  refreshUi();
}

export function jumpSearchMatch(ctx: ActionContext, direction: 'next' | 'prev'): void {
  const { state, refreshUi } = ctx;

  if (state.visibleEntries.length === 0) {
    state.statusMessage = state.searchTerm ? 'No search matches to jump.' : 'Set search filter first with /.';
    refreshUi();
    return;
  }

  if (direction === 'next') {
    state.selectedEntryIndex = (state.selectedEntryIndex + 1) % state.visibleEntries.length;
    state.statusMessage = `Jumped to next match (${state.selectedEntryIndex + 1}/${state.visibleEntries.length}).`;
  } else {
    state.selectedEntryIndex = (state.selectedEntryIndex - 1 + state.visibleEntries.length) % state.visibleEntries.length;
    state.statusMessage = `Jumped to previous match (${state.selectedEntryIndex + 1}/${state.visibleEntries.length}).`;
  }

  refreshUi();
}

export async function addEntry(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;
  const doc = currentDocument(ctx);

  const targetEntry = state.visibleEntries.length > 0
    ? state.visibleEntries[Math.min(state.selectedEntryIndex, state.visibleEntries.length - 1)]
    : null;

  const targetPath = targetEntry?.path ?? [];
  const targetValue = state.editor.getEntryValue(doc.id, targetPath);

  if (targetEntry == null && !Array.isArray(targetValue) && (targetValue == null || typeof targetValue !== 'object')) {
    state.statusMessage = 'No target object/array selected for add.';
    refreshUi();
    return;
  }

  if (targetEntry?.type === 'object' || (targetEntry == null && targetValue != null && typeof targetValue === 'object')) {
    const keyAnswer = await waitForInput(widgets.screen, 'Add Object Key', 'New key name:', '');
    if (keyAnswer == null) {
      state.statusMessage = 'Add canceled.';
      refreshUi();
      return;
    }

    const valueAnswer = await waitForInput(
      widgets.screen,
      'Add Object Key',
      `Value for ${keyAnswer.trim()} (auto parse bool/number):`,
      '',
    );
    if (valueAnswer == null) {
      state.statusMessage = 'Add canceled.';
      refreshUi();
      return;
    }

    try {
      state.editor.addObjectEntry(doc.id, targetPath, keyAnswer, valueAnswer);
      state.hasUnsavedChanges = true;
      state.statusMessage = `Added key '${keyAnswer.trim()}' under ${targetPath.join('.') || '<root>'}.`;
    } catch (error) {
      state.statusMessage = `Add failed: ${(error as Error).message}`;
    }
    refreshUi();
    return;
  }

  if (targetEntry?.type === 'array') {
    const fixedTarget = resolveFixedArrayTarget(targetEntry);
    if (fixedTarget != null) {
      await editFixedArraySelection(state, widgets.screen, doc.id, fixedTarget.arrayPath, fixedTarget.spec, refreshUi);
      return;
    }

    const valueAnswer = await waitForArrayValue(
      widgets.screen,
      null,
      'Append Array Item',
      `Append value to ${targetEntry.pathText}:`,
      '',
    );
    if (valueAnswer == null) {
      state.statusMessage = 'Append canceled.';
      refreshUi();
      return;
    }

    try {
      state.editor.appendArrayEntry(doc.id, targetEntry.path, valueAnswer);
      state.hasUnsavedChanges = true;
      state.statusMessage = `Appended value to ${targetEntry.pathText}.`;
    } catch (error) {
      state.statusMessage = `Append failed: ${(error as Error).message}`;
    }
    refreshUi();
    return;
  }

  state.statusMessage = 'Select an object or array node to add items.';
  refreshUi();
}

export async function insertArrayEntry(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;

  const entry = currentEntry(ctx);
  if (entry == null) {
    state.statusMessage = 'No selected entry for insert.';
    refreshUi();
    return;
  }

  const doc = currentDocument(ctx);
  const target = resolveArrayTarget(entry);
  if (target == null) {
    state.statusMessage = 'Select an array or array item to insert.';
    refreshUi();
    return;
  }

  const fixedSpec = getFixedArraySpecFromEntryPath(target.arrayPath);
  if (fixedSpec != null) {
    await editFixedArraySelection(state, widgets.screen, doc.id, target.arrayPath, fixedSpec, refreshUi);
    return;
  }

  const arrayValue = state.editor.getEntryValue(doc.id, target.arrayPath);
  const arrayLength = Array.isArray(arrayValue) ? arrayValue.length : 0;
  const indexAnswer = await waitForInput(
    widgets.screen,
    'Insert Array Item',
    `Insert index (0-${arrayLength}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
    target.suggestedIndex != null ? String(target.suggestedIndex) : String(arrayLength),
  );
  if (indexAnswer == null) {
    state.statusMessage = 'Insert canceled.';
    refreshUi();
    return;
  }

  const valueAnswer = await waitForArrayValue(
    widgets.screen,
    null,
    'Insert Array Item',
    `Value to insert at ${target.arrayPath.join('.')} (auto parse bool/number):`,
    '',
  );
  if (valueAnswer == null) {
    state.statusMessage = 'Insert canceled.';
    refreshUi();
    return;
  }

  try {
    const indexInput = indexAnswer.trim();
    const insertIndex = indexInput === '' && target.suggestedIndex != null
      ? target.suggestedIndex
      : parseNonNegativeInteger(indexAnswer, 'Insert index');

    state.editor.insertArrayEntry(doc.id, target.arrayPath, insertIndex, valueAnswer);
    state.hasUnsavedChanges = true;
    state.statusMessage = `Inserted array item at ${target.arrayPath.join('.')}[${insertIndex}].`;
  } catch (error) {
    state.statusMessage = `Insert failed: ${(error as Error).message}`;
  }

  refreshUi();
}

export async function moveArrayEntry(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;

  const entry = currentEntry(ctx);
  if (entry == null) {
    state.statusMessage = 'No selected entry for move.';
    refreshUi();
    return;
  }

  const doc = currentDocument(ctx);
  const target = resolveArrayTarget(entry);
  if (target == null) {
    state.statusMessage = 'Select an array or array item to move.';
    refreshUi();
    return;
  }

  const fixedSpec = getFixedArraySpecFromEntryPath(target.arrayPath);
  if (fixedSpec != null) {
    await editFixedArraySelection(state, widgets.screen, doc.id, target.arrayPath, fixedSpec, refreshUi);
    return;
  }

  const arrayValue = state.editor.getEntryValue(doc.id, target.arrayPath);
  const arrayLength = Array.isArray(arrayValue) ? arrayValue.length : 0;

  const fromAnswer = await waitForInput(
    widgets.screen,
    'Move Array Item',
    `Move from index (0-${Math.max(0, arrayLength - 1)}${target.suggestedIndex != null ? `, default ${target.suggestedIndex}` : ''}):`,
    target.suggestedIndex != null ? String(target.suggestedIndex) : '0',
  );
  if (fromAnswer == null) {
    state.statusMessage = 'Move canceled.';
    refreshUi();
    return;
  }

  const toAnswer = await waitForInput(
    widgets.screen,
    'Move Array Item',
    `Move to index (0-${Math.max(0, arrayLength - 1)}):`,
    '0',
  );
  if (toAnswer == null) {
    state.statusMessage = 'Move canceled.';
    refreshUi();
    return;
  }

  try {
    const fromInput = fromAnswer.trim();
    const fromIndex = fromInput === '' && target.suggestedIndex != null
      ? target.suggestedIndex
      : parseNonNegativeInteger(fromAnswer, 'Source index');
    const toIndex = parseNonNegativeInteger(toAnswer, 'Target index');

    state.editor.moveArrayEntry(doc.id, target.arrayPath, fromIndex, toIndex);
    state.hasUnsavedChanges = true;
    state.statusMessage = `Moved item in ${target.arrayPath.join('.')} from ${fromIndex} to ${toIndex}.`;
  } catch (error) {
    state.statusMessage = `Move failed: ${(error as Error).message}`;
  }

  refreshUi();
}

export async function deleteEntry(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;
  const doc = currentDocument(ctx);

  const entry = currentEntry(ctx);
  if (entry == null) {
    state.statusMessage = 'No selected entry to delete.';
    refreshUi();
    return;
  }

  const fixedTarget = resolveFixedArrayTarget(entry);
  if (fixedTarget != null) {
    await editFixedArraySelection(state, widgets.screen, doc.id, fixedTarget.arrayPath, fixedTarget.spec, refreshUi);
    return;
  }

  const confirmed = await waitForConfirm(widgets.screen, 'Delete Path', `Delete ${entry.pathText}?`);
  if (!confirmed) {
    state.statusMessage = 'Delete canceled.';
    refreshUi();
    return;
  }

  try {
    state.editor.deleteDocumentPath(doc.id, entry.path);
    state.hasUnsavedChanges = true;
    state.selectedEntryIndex = Math.max(0, state.selectedEntryIndex - 1);
    state.statusMessage = `Deleted ${entry.pathText}.`;
  } catch (error) {
    state.statusMessage = `Delete failed: ${(error as Error).message}`;
  }
  refreshUi();
}

export async function quitFlow(ctx: ActionContext): Promise<void> {
  const { state, widgets, refreshUi } = ctx;

  if (!state.hasUnsavedChanges) {
    widgets.screen.destroy();
    return;
  }

  const shouldDiscard = await waitForConfirm(
    widgets.screen,
    'Unsaved Changes',
    'You have unsaved changes. Press S to save and exit, or discard changes and exit.',
    {
      confirmLabel: 'Discard & Exit',
      cancelLabel: 'Keep Editing',
      defaultFocus: 'cancel',
    },
  );
  if (shouldDiscard) {
    widgets.screen.destroy();
    return;
  }

  state.statusMessage = 'Continue editing.';
  refreshUi();
}

export function saveAndExit(ctx: ActionContext): void {
  const { state, widgets } = ctx;
  state.editor.save();
  state.hasUnsavedChanges = false;
  state.didSave = true;
  state.statusMessage = 'Saved.';
  widgets.screen.destroy();
}
