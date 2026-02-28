import { Widgets } from 'blessed';

/**
 * Safely read the `selected` index from a blessed list element.
 * Blessed exposes `.selected` at runtime but the type declarations omit it.
 */
export function getListSelected(list: Widgets.ListElement): number {
  return (list as unknown as { selected?: number }).selected ?? 0;
}
