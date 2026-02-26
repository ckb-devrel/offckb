# TUI Refactoring Plan

## Status Tracker

- [x] Step 1: Write refactoring plan doc
- [x] Step 2: Add `setArrayValues()` to `DevnetConfigEditor`
- [x] Step 3: Create `src/tui/blessed-helpers.ts`
- [x] Step 4: Create `src/tui/tui-state.ts`
- [x] Step 5: Create `src/tui/dialogs.ts` (3 dialog functions)
- [x] Step 6: Create `src/tui/format.ts` (entry line formatter)
- [x] Step 7: Create `src/tui/actions.ts` (all 8 action functions)
- [x] Step 8: Rewrite `src/tui/devnet-config-tui.ts` as thin orchestrator
- [x] Step 9: Verify build + tests pass

## Current State

Three files, ~2060 lines total:
- `src/node/devnet-config-editor.ts` (628 lines) — data layer, well structured
- `src/tui/devnet-config-metadata.ts` (213 lines) — metadata, fine as-is
- `src/tui/devnet-config-tui.ts` (1220 lines) — **needs refactoring**

The TUI file has one 700-line god function (`runDevnetConfigTui`) with 10 closure
variables shared by 30+ inner functions, 3 duplicated dialog patterns, and 14
repeated `if (dialogLock) return;` guards.

## Target File Structure

```
src/tui/
  blessed-helpers.ts       (~30 lines)  - getListSelected(), type helpers
  tui-state.ts             (~70 lines)  - TuiState interface + factory
  dialogs.ts               (~220 lines) - 3 dialog functions (input, confirm, select)
  format.ts                (~35 lines)  - formatEntryLine()
  actions.ts               (~330 lines) - all 8 action functions
  devnet-config-tui.ts     (~150 lines) - layout, keybindings, main orchestrator
  devnet-config-metadata.ts              - UNCHANGED
```

Total: ~835 lines (down from 1220), no function over ~70 lines.

## Shared Interfaces

### TuiState (tui-state.ts)

```typescript
import { Widgets } from 'blessed';
import { DevnetConfigEditor, TomlEntry, TomlDocument } from '../node/devnet-config-editor';

export type FocusPane = 'files' | 'entries';

export interface TuiState {
  editor: DevnetConfigEditor;
  configPath: string;
  documents: TomlDocument[];
  selectedDocumentIndex: number;
  selectedEntryIndex: number;
  focusPane: FocusPane;
  hasUnsavedChanges: boolean;
  didSave: boolean;
  searchTerm: string;
  statusMessage: string;
  visibleEntries: TomlEntry[];
  dialogLock: boolean;
}

export interface TuiWidgets {
  screen: Widgets.Screen;
  filesList: Widgets.ListElement;
  entriesList: Widgets.ListElement;
  statusBar: Widgets.BoxElement;
}

export function createTuiState(editor, configPath): TuiState { ... }
```

### Action Function Signature

Every action receives `(state, widgets)` and returns `Promise<void>`.
Actions mutate `state` directly (it's a mutable bag). They call
`refreshUi(state, widgets)` at the end.

### Dialog Functions

Unchanged signatures — they take `screen` and return Promise. They are already
reasonably independent; we just consolidate them into one file and remove
duplicated boilerplate.

## Step-by-Step Execution

### Step 2: Add `setArrayValues()` to editor

Fix the encapsulation leak where TUI directly `splice()`s editor internals.
Add a proper method to `DevnetConfigEditor`:

```typescript
setArrayValues(documentId, pathParts, values: string[]): void
```

### Step 3: Create `blessed-helpers.ts`

Extract the repeated `as unknown as { selected?: number }` pattern:

```typescript
export function getListSelected(list: Widgets.ListElement): number
```

### Step 4: Create `tui-state.ts`

Extract `TuiState`, `TuiWidgets`, `FocusPane` types and `createTuiState()`.

### Step 5: Create `dialogs.ts`

Move `waitForInput`, `waitForConfirm`, `waitForFixedArraySelection`,
`waitForArrayValue` into this file. No structural changes to the functions
themselves — just relocation + import cleanup.

### Step 6: Create `format.ts`

Move `formatEntryLine()` into its own file.

### Step 7: Create `actions.ts`

Extract all action logic from the god function into standalone functions:

```typescript
export async function editCurrentEntry(state, widgets): Promise<void>
export async function addEntry(state, widgets): Promise<void>
export async function deleteEntry(state, widgets): Promise<void>
export async function insertArrayEntry(state, widgets): Promise<void>
export async function moveArrayEntry(state, widgets): Promise<void>
export async function searchEntries(state, widgets): Promise<void>
export function jumpSearchMatch(state, widgets, direction): void
export async function editFixedArraySelection(state, widgets, ...): Promise<void>

// Also extract these pure helpers:
export function resolveArrayTarget(entry): { arrayPath, suggestedIndex } | null
export function resolveFixedArrayTarget(entry): { arrayPath, spec } | null
export function parseNonNegativeInteger(value, fieldName): number
```

Each function takes `(state: TuiState, widgets: TuiWidgets, ...)` explicitly.

### Step 8: Rewrite main `devnet-config-tui.ts`

The main file becomes a thin orchestrator (~150 lines):
1. TTY check
2. Create screen + layout widgets
3. Create TuiState
4. `refreshUi()` function
5. `withDialogLock()` helper
6. `guardedKey()` helper — eliminates 14x `if (dialogLock) return;`
7. All key bindings (compact, using guardedKey)
8. List sync event handlers
9. Return `Promise<boolean>` on screen destroy

### Step 9: Verify

- `npx tsc --noEmit` passes
- `npx jest tests/ --no-coverage` all pass
- No new lint errors

## Key Design Decisions

1. **State is a plain mutable object, not a class** — keeps it simple,
   avoids getter/setter boilerplate. Actions mutate it directly.
2. **`refreshUi` stays in the main file** — it's the only function that
   needs all widgets + state together. Actions call it via the widgets ref.
3. **Dialogs remain standalone functions** — they don't need state, only screen.
4. **No event emitter / pub-sub** — overkill for this scale. Direct function
   calls are clearer.
5. **`devnet-config-metadata.ts` unchanged** — it's already clean.
6. **`devnet-config-editor.ts` gets one new method** — `setArrayValues()` to
   fix the encapsulation leak.
