/**
 * The file-search categories, as ids the config can name and the plugin sorts by.
 *
 * File search is the one plugin that is also a *setting*: it ships inside the
 * application, it has a global key of its own, and the order its results come
 * back in is something a person wants to change without editing a plugin. So the
 * vocabulary lives here — renderer-safe, next to the rest of the config's types
 * — and `[file_search].order` is written in these ids.
 *
 * The plugin holds the other half: which extensions land in which category. That
 * table is deliberately *not* here. A plugin is a program that talks to the
 * launcher through `lumanin` and nothing else, and one reaching into the app's
 * own modules would be a plugin nobody could copy. The contract between the two
 * halves is these eight ids and the `[file_search]` config section.
 */

export const FILE_CATEGORIES = [
  'folders',
  'images',
  'videos',
  'archives',
  'models',
  'text',
  'executables',
  'rest'
] as const

export type FileCategory = (typeof FILE_CATEGORIES)[number]

export const FILE_CATEGORY_TITLES: Readonly<Record<FileCategory, string>> = {
  folders: 'Folders',
  images: 'Images',
  videos: 'Videos',
  archives: 'Archives',
  models: '3D Files',
  text: 'Text',
  executables: 'Executables',
  rest: 'Rest'
}

/** What each one holds, for the screen that orders them. */
export const FILE_CATEGORY_HINTS: Readonly<Record<FileCategory, string>> = {
  folders: 'Directories',
  images: 'png, jpg, svg, raw, psd…',
  videos: 'mp4, mkv, mov, webm…',
  archives: 'zip, rar, 7z, tar, gz, iso…',
  models: 'blend, stl, 3mf, obj, gltf, step…',
  text: 'md, txt, code, json, pdf, docx…',
  executables: 'AppImage, jar, apk, anything with the executable bit',
  rest: 'Everything not in a category above'
}

/**
 * The default, which is also the order the launcher shipped with.
 *
 * Folders first because entering one is how browsing starts, and `rest` last
 * because it is the category defined by not being any of the others.
 */
export const DEFAULT_FILE_ORDER: readonly FileCategory[] = FILE_CATEGORIES

/**
 * A configured order, completed.
 *
 * Unknown names are dropped and missing ones are appended in default order,
 * rather than the whole list being refused: every file lands in exactly one
 * category, so a category left out of the setting still has to sort somewhere,
 * and "wherever it was" is the only answer that does not hide files.
 */
export function completeFileOrder(listed: readonly string[]): readonly FileCategory[] {
  const known = listed.filter((entry): entry is FileCategory =>
    (FILE_CATEGORIES as readonly string[]).includes(entry)
  )
  const seen = new Set(known)
  return [...new Set(known), ...DEFAULT_FILE_ORDER.filter((category) => !seen.has(category))]
}
