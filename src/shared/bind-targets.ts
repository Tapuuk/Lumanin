/**
 * The launcher's own `open` targets: binds that live in the managed block
 * because the launcher put them there, not because of a `[[hotkeys]]` entry.
 * The renderer cannot reach the planner, so this set is spelled here and
 * `launcherOwnedTargets()` in `src/platform/fix/actions.ts` derives the same
 * set from `bindSpecs`; a test pins the two to each other.
 */
export const FILE_SEARCH_COMMAND = 'files/search'

export const LAUNCHER_OWNED_TARGETS: ReadonlySet<string> = new Set([`extension:${FILE_SEARCH_COMMAND}`])
