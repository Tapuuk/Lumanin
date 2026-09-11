/**
 * List-selection arithmetic.
 *
 * Extracted from the view because it is the part that can be wrong: an index
 * that walks off either end of the list is not a rendering glitch, it is the
 * launcher acting on a row the user cannot see. It is pure, so it is tested.
 */

/**
 * Move the selection by `step`, staying inside the list.
 *
 * An empty list has no valid index, and the caller gets 0 rather than -1:
 * clamping only against `count - 1` produced -1 for an empty list and left it
 * there, so the next set of results arrived with nothing selected at all.
 */
export function moveSelection(index: number, step: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(index + step, 0), count - 1)
}

/** Pull an existing index back inside a list that changed size underneath it. */
export function clampSelection(index: number, count: number): number {
  return moveSelection(index, 0, count)
}
