import { Widgets } from 'blessed';
import { DevnetConfigEditor, TomlDocument, TomlEntry } from '../devnet/config-editor';

export type FocusPane = 'files' | 'entries';

export interface TuiState {
  readonly editor: DevnetConfigEditor;
  readonly configPath: string;
  readonly documents: TomlDocument[];
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

export function createTuiState(editor: DevnetConfigEditor, configPath: string): TuiState {
  return {
    editor,
    configPath,
    documents: editor.getDocuments(),
    selectedDocumentIndex: 0,
    selectedEntryIndex: 0,
    focusPane: 'files',
    hasUnsavedChanges: false,
    didSave: false,
    searchTerm: '',
    statusMessage: 'Ready',
    visibleEntries: [],
    dialogLock: false,
  };
}
