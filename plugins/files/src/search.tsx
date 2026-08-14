import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, sep } from 'node:path'
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  clearSearchBar,
  closeMainWindow,
  getPreferenceValues,
  open,
  showToast,
  useExec,
  useNavigation
} from 'lumanin'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Search Files — a search of its own, not a row in the root list.
 *
 * This is the whole reason it is a plugin, and the reason it is the one plugin
 * that never appears at the root (`lumanin.root: false` in the manifest). The
 * root answers "what did you mean" in one keystroke out of a few thousand
 * indexed names; a filesystem is neither small enough to rank that way nor fast
 * enough to re-scan per keystroke. Every launcher that mixes the two ends up
 * with a root list that stutters and fills with `node_modules`.
 *
 * So it is a second surface with a key of its own — `[file_search].hotkey`,
 * Super+Shift+R by default — and nothing else opens it. One search bar, one
 * question: which file. Escape closes it rather than dropping into the launcher,
 * because there is no launcher behind it to drop into.
 *
 * Scope is always the home directory and everything under it. It was a dropdown
 * for a day; a picker that has to be *set* before you can type is a question
 * asked before the one you came to ask, and the answer was ~ every time.
 *
 * Nothing here indexes anything. The tools that already exist on a Linux machine
 * are better at this than a database of ours would be, and they are already warm:
 * `fd` walks a home directory faster than we could query SQLite, and `plocate`
 * answers from an index the system already maintains. We shell out and render.
 */

interface Preferences {
  readonly showHidden?: boolean
  readonly tool?: 'auto' | 'fd' | 'locate' | 'find'
}

/** How many rows are worth showing. Past this nobody scrolls; they retype. */
const LIMIT = 200

/** A slow filesystem must not hang the view — `find` on a cold cache can. */
const TIMEOUT_MS = 6000

// ─── what to search with ────────────────────────────────────────────────────

type ToolName = 'fd' | 'locate' | 'find'

interface Tool {
  readonly name: ToolName
  /** Absolute path, so nothing depends on the worker's PATH at spawn time. */
  readonly path: string
}

/**
 * Find an executable on PATH without spawning anything.
 *
 * `which` would mean a child process per candidate on every view open, to answer
 * a question `readdir`-free `existsSync` answers in microseconds. It also keeps
 * this honest about SECURITY.md's rule on argv: there is no shell here at all,
 * not even to look something up.
 */
function onPath(names: readonly string[]): string | null {
  const path = process.env['PATH'] ?? ''
  for (const name of names) {
    for (const directory of path.split(':')) {
      if (directory.length === 0) continue
      const candidate = join(directory, name)
      try {
        // `statSync`, not `lstatSync`: a PATH entry is allowed to be a symlink
        // (Nix, `~/.local/bin` shims), and what matters is what it points at.
        if (statSync(candidate).isFile()) return candidate
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * Which tool answers this search.
 *
 * Order is by how good the answer is, not by how common the tool is. `fd`
 * respects `.gitignore`, which is the difference between finding your source
 * file and finding forty copies of it under `node_modules`. `plocate` is
 * instant but answers from a database that is as old as the last `updatedb`, so
 * a file saved a minute ago is not in it. `find` is always there and is always
 * the slowest; it exists so that this feature never simply does not work.
 */
function pickTool(preferred: Preferences['tool']): Tool | null {
  const fd = (): Tool | null => {
    // Debian and Ubuntu ship the binary as `fdfind`, because `fd` was taken.
    const path = onPath(['fd', 'fdfind'])
    return path === null ? null : { name: 'fd', path }
  }
  const locate = (): Tool | null => {
    const path = onPath(['plocate', 'locate'])
    return path === null ? null : { name: 'locate', path }
  }
  const find = (): Tool | null => {
    const path = onPath(['find'])
    return path === null ? null : { name: 'find', path }
  }

  if (preferred === 'fd') return fd()
  if (preferred === 'locate') return locate()
  if (preferred === 'find') return find()
  return fd() ?? locate() ?? find()
}

/** Every character that means something to a regex, quoted. */
function quoteRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The query as a pattern.
 *
 * Words are joined with `.*` so "src index" finds `src/index.ts` — typing two
 * halves of a name in order is how people actually search — and each word is
 * quoted first, so a query containing `(` or `+` is a search for those
 * characters rather than a regex error.
 */
function pattern(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).map(quoteRegex).join('.*')
}

/** The argv for one search. Never a shell string — SECURITY.md §"Spawning". */
function argsFor(tool: Tool, query: string, root: string, hidden: boolean): readonly string[] {
  switch (tool.name) {
    case 'fd':
      return [
        '--absolute-path',
        '--color', 'never',
        '--ignore-case',
        '--max-results', String(LIMIT),
        ...(hidden ? ['--hidden'] : []),
        // Ours, not the user's project layout: `.git` is never the answer to a
        // file search, and its object files are half the entries under any repo.
        '--exclude', '.git',
        '--', pattern(query), root
      ]
    case 'locate':
      // `--basename` matches the name rather than the whole path, which is what
      // the other two do; without it, searching "src" returns every file in
      // every directory called src. The root is applied after the fact — locate
      // has no way to be told one.
      return ['--ignore-case', '--basename', '--limit', String(LIMIT * 4), '--regexp', pattern(query)]
    case 'find':
      // No regex, but `-iname` globs: words joined with `*` still match a name
      // in order, so "quarterly report" finds `quarterly-report.md` here too.
      // Depth-bounded because an unbounded `find ~` on a cold cache is minutes.
      return [
        root,
        '-maxdepth', '6',
        ...(hidden ? [] : ['-not', '-path', '*/.*']),
        '-iname', `*${query.trim().split(/\s+/).map((word) => word.replace(/[*?[\]]/g, '')).join('*')}*`,
        '-print'
      ]
  }
}

// ─── icons ──────────────────────────────────────────────────────────────────

/**
 * The desktop's own icon, by freedesktop name.
 *
 * `system:` is a source the launcher resolves against the **icon theme the
 * session is set to** — Breeze on KDE, Adwaita on GNOME, Papirus if that is what
 * is installed — which is the whole point: a file list should look like the file
 * manager sitting next to it, not like a set of glyphs a launcher drew. Names
 * are tried in order, so each entry below names the specific icon first and a
 * generic one after it; a theme is free to ship any subset, and a page is a
 * better answer than nothing.
 */
const GENERIC = 'text-x-generic,text-x-preview,application-x-zerosize'

const BY_EXTENSION: Readonly<Record<string, string>> = {
  // Text and code. `text-x-script` is what most themes give anything runnable.
  txt: 'text-plain,text-x-generic',
  md: 'text-markdown,text-x-generic',
  rst: 'text-x-rst,text-x-generic',
  json: 'application-json,text-x-generic',
  toml: 'text-x-toml,text-x-generic',
  yaml: 'text-x-yaml,text-x-generic',
  yml: 'text-x-yaml,text-x-generic',
  xml: 'text-xml,text-x-generic',
  html: 'text-html,text-x-generic',
  css: 'text-css,text-x-generic',
  js: 'text-x-javascript,text-x-script,text-x-generic',
  ts: 'text-x-typescript,text-x-script,text-x-generic',
  tsx: 'text-x-typescript,text-x-script,text-x-generic',
  jsx: 'text-x-javascript,text-x-script,text-x-generic',
  py: 'text-x-python,text-x-script,text-x-generic',
  rs: 'text-x-rust,text-x-script,text-x-generic',
  go: 'text-x-go,text-x-script,text-x-generic',
  c: 'text-x-csrc,text-x-generic',
  h: 'text-x-chdr,text-x-generic',
  cpp: 'text-x-c++src,text-x-generic',
  java: 'text-x-java,text-x-generic',
  sh: 'application-x-shellscript,text-x-script,text-x-generic',
  // Documents.
  pdf: 'application-pdf,x-office-document',
  doc: 'application-msword,x-office-document',
  docx: 'application-vnd.openxmlformats-officedocument.wordprocessingml.document,x-office-document',
  odt: 'application-vnd.oasis.opendocument.text,x-office-document',
  xls: 'application-vnd.ms-excel,x-office-spreadsheet',
  xlsx: 'application-vnd.openxmlformats-officedocument.spreadsheetml.sheet,x-office-spreadsheet',
  ods: 'application-vnd.oasis.opendocument.spreadsheet,x-office-spreadsheet',
  ppt: 'application-vnd.ms-powerpoint,x-office-presentation',
  pptx: 'application-vnd.openxmlformats-officedocument.presentationml.presentation,x-office-presentation',
  odp: 'application-vnd.oasis.opendocument.presentation,x-office-presentation',
  csv: 'text-csv,x-office-spreadsheet,text-x-generic',
  // Media.
  png: 'image-png,image-x-generic',
  jpg: 'image-jpeg,image-x-generic',
  jpeg: 'image-jpeg,image-x-generic',
  gif: 'image-gif,image-x-generic',
  webp: 'image-webp,image-x-generic',
  svg: 'image-svg+xml,image-x-generic',
  bmp: 'image-bmp,image-x-generic',
  ico: 'image-x-ico,image-x-generic',
  mp3: 'audio-mpeg,audio-x-generic',
  flac: 'audio-flac,audio-x-generic',
  wav: 'audio-x-wav,audio-x-generic',
  ogg: 'audio-x-vorbis+ogg,audio-x-generic',
  m4a: 'audio-mp4,audio-x-generic',
  mp4: 'video-mp4,video-x-generic',
  mkv: 'video-x-matroska,video-x-generic',
  webm: 'video-webm,video-x-generic',
  mov: 'video-quicktime,video-x-generic',
  avi: 'video-x-msvideo,video-x-generic',
  // Archives and packages.
  zip: 'application-zip,package-x-generic',
  gz: 'application-x-gzip,package-x-generic',
  xz: 'application-x-xz,package-x-generic',
  bz2: 'application-x-bzip,package-x-generic',
  tar: 'application-x-tar,package-x-generic',
  zst: 'application-zstd,package-x-generic',
  '7z': 'application-x-7z-compressed,package-x-generic',
  rar: 'application-x-rar,package-x-generic',
  deb: 'application-x-deb,package-x-generic',
  rpm: 'application-x-rpm,package-x-generic',
  iso: 'application-x-cd-image,media-optical',
  // The odd ones out.
  desktop: 'application-x-desktop,text-x-generic',
  ttf: 'font-x-generic',
  otf: 'font-x-generic'
}

function iconFor(hit: Hit): string {
  if (hit.directory) return 'system:folder,inode-directory,folder-blue'
  const extension = extname(hit.name).slice(1).toLowerCase()
  return `system:${BY_EXTENSION[extension] ?? GENERIC}`
}

// ─── kinds of file ──────────────────────────────────────────────────────────

/**
 * The eight categories, and which extensions land in each.
 *
 * The ids are a contract with the launcher: `[file_search].order` is written in
 * them, and the settings screen orders them by these names. The *table* is ours
 * alone and deliberately not shared — a plugin is a program that talks to the
 * launcher through `lumanin` and nothing else, and one reaching into the app's
 * own modules would be a plugin nobody could copy.
 *
 * Every file is in exactly one category, `rest` is the one defined by not being
 * any of the others, and nothing is ever filtered out: this decides what a file
 * sorts *with*, never whether you see it.
 */
type Category =
  | 'folders'
  | 'images'
  | 'videos'
  | 'archives'
  | 'models'
  | 'text'
  | 'executables'
  | 'rest'

const DEFAULT_ORDER: readonly Category[] = [
  'folders',
  'images',
  'videos',
  'archives',
  'models',
  'text',
  'executables',
  'rest'
]

const CATEGORY_TITLES: Readonly<Record<Category, string>> = {
  folders: 'Folders',
  images: 'Images',
  videos: 'Videos',
  archives: 'Archives',
  models: '3D Files',
  text: 'Text',
  executables: 'Executables',
  rest: 'Rest'
}

/**
 * Extension → category, written as one list per category and inverted below.
 *
 * Long on purpose. A table with the twenty formats everyone knows leaves a
 * photographer's raws, a machinist's STEP files and a writer's manuscripts all
 * in "Rest", which is the one category that cannot be ordered usefully. The rule
 * for adding one: name it if a person would say "that is a picture / a video / a
 * 3D file / something I read" without hesitating.
 */
const CATEGORY_EXTENSIONS: Readonly<Record<Exclude<Category, 'folders' | 'rest'>, readonly string[]>> = {
  images: [
    'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'avif', 'jxl', 'bmp', 'ico', 'icns',
    'tif', 'tiff', 'svg', 'svgz', 'heic', 'heif', 'qoi', 'tga', 'exr', 'hdr', 'dds', 'ppm',
    'pgm', 'pbm', 'pnm', 'xpm',
    // Raw, which is most of what is on a camera's card.
    'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'sr2', 'pef', 'srw', 'x3f',
    // Editable images. A .psd is not a picture the way a .png is, but it is
    // never anything else either.
    'psd', 'xcf', 'kra', 'ora', 'ai', 'afphoto', 'afdesign', 'clip', 'procreate'
  ],
  videos: [
    'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm2v',
    'ts', 'mts', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'rm', 'rmvb', 'asf', 'divx', 'mxf', 'y4m',
    // Project files of the programs that make them.
    'prproj', 'kdenlive', 'veg', 'fcpxml'
  ],
  archives: [
    'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'tzst',
    'lz4', 'lzma', 'lz', 'lzh', 'arj', 'cab', 'cpio', 'ar', 'iso', 'squashfs', 'sfs',
    // Packages are archives to a person looking for the file they downloaded —
    // the installable kinds with a desktop of their own (apk, snap, flatpak)
    // stay in Executables, which already claimed them.
    'deb', 'rpm'
  ],
  models: [
    // Printing and scanning.
    'stl', '3mf', 'amf', 'gcode', 'bgcode', 'ply', 'obj', 'mtl', 'off', 'vox',
    // Authoring.
    'blend', 'blend1', 'fbx', 'dae', 'gltf', 'glb', 'abc', 'usd', 'usda', 'usdc', 'usdz',
    'ma', 'mb', 'max', '3ds', 'c4d', 'lwo', 'lws', 'ztl', 'zpr', 'x3d', 'wrl', 'skp',
    // CAD, which is the other half of what "3D file" means to people.
    'step', 'stp', 'iges', 'igs', 'brep', 'scad', 'f3d', 'f3z', 'ipt', 'iam', 'sldprt',
    'sldasm', 'prt', 'catpart', 'catproduct', '3dm', 'dwg', 'dxf'
  ],
  text: [
    // Plain text and prose.
    'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'org', 'adoc', 'asciidoc', 'tex', 'bib',
    'log', 'nfo', 'srt', 'vtt', 'ass', 'sub', 'csv', 'tsv',
    // Configuration and data, which is most of what is in a dotfile directory.
    'json', 'jsonc', 'json5', 'toml', 'yaml', 'yml', 'xml', 'ini', 'cfg', 'conf', 'properties',
    'env', 'editorconfig', 'lock', 'patch', 'diff', 'desktop', 'service', 'rules',
    // Source. Not split out as its own category — the setting names eight and
    // this is the one they belong to.
    'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts',
    'tsx', 'mts', 'cts', 'py', 'pyi', 'rb', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp',
    'hh', 'java', 'kt', 'kts', 'swift', 'cs', 'php', 'pl', 'pm', 'lua', 'sh', 'bash', 'zsh',
    'fish', 'ps1', 'sql', 'r', 'jl', 'scala', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'ml',
    'nim', 'zig', 'v', 'd', 'dart', 'vim', 'el', 'vue', 'svelte', 'astro', 'gradle', 'cmake',
    'mk', 'makefile', 'dockerfile', 'gitignore', 'proto', 'graphql', 'ipynb',
    // Documents. Not text in the byte sense, but the same answer to "what is
    // this" — something you open to read, and the category people look in.
    'pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'djvu', 'mobi', 'azw3', 'fb2', 'pages',
    'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key'
  ],
  executables: [
    'appimage', 'exe', 'msi', 'bin', 'run', 'com', 'apk', 'jar', 'snap', 'flatpak',
    'flatpakref', 'appx', 'msix', 'bat', 'cmd', 'so', 'dll', 'dylib', 'ko'
  ]
}

const CATEGORY_BY_EXTENSION: Readonly<Record<string, Category>> = Object.fromEntries(
  Object.entries(CATEGORY_EXTENSIONS).flatMap(([category, list]) =>
    list.map((extension) => [extension, category as Category])
  )
)

/** The executable bit, for anything the extension table did not claim. */
const EXECUTABLE_BIT = 0o111

/**
 * Does anyone have permission to run this?
 *
 * Any of the three bits rather than the caller's own: a file in your home
 * directory that is `--x` for others and not for you is a mistake in its mode,
 * not a different kind of file, and it belongs with the programs either way.
 * Answered with the stat that was taken anyway; never for a directory, where the
 * bit means "may be entered" and would put every folder in the wrong category.
 */
function isExecutable(path: string, directory: boolean): boolean {
  if (directory) return false
  try {
    return (lstatSync(path).mode & EXECUTABLE_BIT) !== 0
  } catch {
    return false
  }
}

/**
 * Which category a hit is in.
 *
 * The extension decides first, and the executable bit only breaks the tie for
 * what is left. That ordering is deliberate: a `.sh` and a `.py` have the bit
 * set as often as not, and they are things you open in an editor — while a
 * compiled binary, which is what people mean by "executable", usually has no
 * extension at all and can be identified no other way.
 */
function categoryOf(hit: Hit): Category {
  if (hit.directory) return 'folders'
  const extension = extname(hit.name).slice(1).toLowerCase()
  const known = CATEGORY_BY_EXTENSION[extension]
  if (known !== undefined) return known
  return hit.executable ? 'executables' : 'rest'
}

/**
 * `[file_search]`, read straight off disk.
 *
 * A plugin has no way to ask the launcher for a setting that is not one of its
 * own preferences, and this one deliberately is not: it belongs in the settings
 * menu next to the key that opens this view, not behind a plugin's preferences
 * screen. So it is read the same way this plugin reads `user-dirs.dirs` — a few
 * lines of scanning against a format we do not own.
 *
 * Scanning rather than parsing, and only this one key: a TOML parser here would
 * be a dependency for one array, and one that failed on some *other* section's
 * syntax would take file search down with it. Anything unreadable, absent or
 * unrecognised falls back to the default order, which is a working view.
 */
interface Settings {
  readonly order: readonly Category[]
  /** `hide_on_open`: close the panel when a file is handed to another program. */
  readonly hideOnOpen: boolean
}

const DEFAULT_SETTINGS: Settings = { order: DEFAULT_ORDER, hideOnOpen: true }

function configuredSettings(): Settings {
  const configHome = process.env['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.startsWith(sep)
      ? configHome
      : join(homedir(), '.config')

  let text: string
  try {
    text = readFileSync(join(base, 'lumanin', 'config.toml'), 'utf8')
  } catch {
    return DEFAULT_SETTINGS
  }

  let order = DEFAULT_ORDER
  let hideOnOpen = DEFAULT_SETTINGS.hideOnOpen
  let inSection = false

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inSection = trimmed === '[file_search]'
      continue
    }
    if (!inSection) continue

    const listed = /^order\s*=\s*\[(.*)\]/.exec(trimmed)
    if (listed !== null) {
      const named = (listed[1] ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
        .filter((entry): entry is Category => (DEFAULT_ORDER as readonly string[]).includes(entry))
      // Completed, never taken literally: every file is in exactly one category,
      // so one left out of the setting still has to sort somewhere. Appending it
      // is the only answer that does not hide files.
      if (named.length > 0) order = [...new Set([...named, ...DEFAULT_ORDER])]
      continue
    }

    const hide = /^hide_on_open\s*=\s*(true|false)/.exec(trimmed)
    if (hide !== null) hideOnOpen = hide[1] === 'true'
  }

  return { order, hideOnOpen }
}

// ─── ranking ────────────────────────────────────────────────────────────────

interface Hit {
  readonly path: string
  readonly name: string
  readonly directory: boolean
  /** Has the executable bit and is not a directory. See {@link categoryOf}. */
  readonly executable: boolean
}

/**
 * Order the tool's output: by category, then outwards from home.
 *
 * `fd` returns traversal order and `locate` returns database order, and neither
 * is an answer to "which of these did you mean". Two rules, in this order:
 *
 * 1. **The configured category order.** Folders first by default, because a
 *    folder is a place to continue the search from rather than an answer to it.
 * 2. **Distance from home.** `~/notes.md` before `~/a/b/c/notes.md`. Depth is a
 *    good proxy for "yours" against "something a tool put there": the files a
 *    person made and named are near the top of their home directory, and the
 *    thousands under `.cache`, `node_modules` and `target` are not.
 *
 * Only then does the name break the tie — a prefix match ahead of a match in the
 * middle, the way the launcher orders everything else (CONFIG.md §"How a matched
 * row is ordered"). It is last rather than first because within one category at
 * one depth there are rarely more than a handful of rows left to separate.
 */
function rank(hits: readonly Hit[], query: string, order: readonly Category[], home: string): readonly Hit[] {
  const needle = query.trim().toLowerCase()
  const rankOf = new Map(order.map((category, index) => [category, index]))

  const tier = (hit: Hit): number => {
    const name = hit.name.toLowerCase()
    if (name.startsWith(needle)) return 0
    if (name.includes(needle)) return 1
    return 2
  }
  // Segments below home, so a search rooted at `~` counts from 0 whatever the
  // user's home is called. A path outside home cannot happen while home is the
  // only root, and would count from `/` if it ever did.
  const depth = (hit: Hit): number =>
    (hit.path.startsWith(`${home}${sep}`) ? hit.path.slice(home.length + 1) : hit.path).split(sep)
      .length

  return [...hits].sort(
    (a, b) =>
      (rankOf.get(categoryOf(a)) ?? order.length) - (rankOf.get(categoryOf(b)) ?? order.length) ||
      depth(a) - depth(b) ||
      tier(a) - tier(b) ||
      a.name.length - b.name.length ||
      a.path.localeCompare(b.path)
  )
}

/**
 * Wait for the typing to stop before spending a process on it.
 *
 * `<List throttle>` is accepted and ignored by this launcher, so nothing else
 * does this. Without it, "report" spawns six searches — `r`, `re`, `rep`, … —
 * and the first five are aborted a few milliseconds later. `useExec` killing the
 * superseded child keeps that correct but not cheap, and the first of those six
 * is the expensive one: `r` matches most of a home directory.
 *
 * Short enough to feel immediate: a search still starts inside the gap between
 * finishing a word and reading the screen.
 */
const DEBOUNCE_MS = 120

function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value)
  const at = useRef(value)
  at.current = value

  useEffect(() => {
    // Clearing the box is not typing — the empty query stops the search, and it
    // should stop it now rather than a tenth of a second from now.
    if (value.length === 0) {
      setSettled('')
      return
    }
    const timer = setTimeout(() => setSettled(at.current), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}

/** `/home/you/notes` → `~/notes`, which is how a person writes it. */
function tilde(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

// ─── a terminal, here ───────────────────────────────────────────────────────

/**
 * Terminals to try, in the order a Linux desktop is likely to have them.
 * `$TERMINAL` wins because a user who set it has already answered this.
 *
 * The same list the launcher itself keeps for `Terminal=true` desktop entries —
 * duplicated rather than shared, because a plugin is a program that talks to the
 * app through `lumanin` and nothing else, and a bundled one that reached into
 * the platform layer would be a bundled one nobody could copy.
 */
const TERMINALS = [
  'ghostty',
  'alacritty',
  'kitty',
  'foot',
  'wezterm',
  'konsole',
  'gnome-terminal',
  'xfce4-terminal',
  'xterm'
] as const

/**
 * Open a terminal *in* a directory.
 *
 * By the child's working directory, not by a flag. Every terminal spells the
 * flag differently — `--working-directory`, `--directory`, `--workdir`,
 * `start --cwd` — and the wrong one is either an error or, worse, silently
 * ignored, leaving a terminal in `$HOME` that looks like it worked. A shell
 * inherits the process's cwd, so setting it is the one spelling they all share.
 *
 * Detached and unref'd: the terminal has to outlive both this worker (which ends
 * with the session) and the launcher itself. `error` is listened for because a
 * failed spawn reports ENOENT on a later tick, and an unheard `error` event is
 * rethrown — inside a worker that means an error card instead of a terminal.
 */
async function openTerminal(directory: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const preferred = process.env['TERMINAL']
  const command =
    preferred !== undefined && preferred.length > 0
      ? (onPath([preferred]) ?? (preferred.includes('/') ? preferred : null))
      : onPath([...TERMINALS])

  if (command === null) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'No terminal emulator found',
      message: 'Install one, or set $TERMINAL to the one you use.'
    })
    return
  }

  const child = spawn(command, [], { cwd: directory, detached: true, stdio: 'ignore' })
  child.on('error', (error: Error) => {
    void showToast({ style: Toast.Style.Failure, title: 'Could not open a terminal', message: error.message })
  })
  child.unref()
  await closeMainWindow()
}

// ─── browsing ───────────────────────────────────────────────────────────────

/**
 * One row, rendered the same way wherever it came from.
 *
 * The action **order** is the interesting part, not the list. The launcher binds
 * Enter to the first action and `secondary` — Space, or Ctrl+Enter while you are
 * typing — to the second, so ordering them is how this feature gets its
 * behaviour: on a folder, Enter goes *in* and Space opens it in the file
 * manager; on a file, Enter opens it and Space shows it in its folder. That is
 * what every file manager does, and it means neither key is ever dead.
 */
function Row({
  hit,
  home,
  hideOnOpen,
  onEnter
}: {
  hit: Hit
  home: string
  hideOnOpen: boolean
  onEnter: (hit: Hit) => void
}): React.JSX.Element {
  /**
   * Hand a path to whatever claims it, and get out of the way.
   *
   * `hideOnOpen` — `[file_search].hide_on_open`, on by default — is what makes
   * opening a file the *end* of a file search. The program that opens it takes
   * the keyboard, and a launcher left on screen behind it is a window that looks
   * alive and is not: its arrow keys do nothing, because the keyboard is
   * somewhere else. That was the reported bug ("the scrolling stops working
   * afterwards"), and it covers the file manager too — the same thing happens
   * whether what opened is an editor, a viewer or Nautilus.
   *
   * `Action.Open` is not used for these, only because it cannot close the
   * window: the shim's `open()` hands off and returns, which is the right
   * default for a plugin that has more to show afterwards.
   */
  const handOff = async (target: string): Promise<void> => {
    await open(target)
    if (hideOnOpen) await closeMainWindow()
  }

  return (
    <List.Item
      // Stable across searches and listings, which is what pinning one row needs.
      key={hit.path}
      id={hit.path}
      icon={iconFor(hit)}
      title={hit.name}
      subtitle={tilde(dirname(hit.path), home)}
      actions={
        <ActionPanel>
          {/* The first section is what the keys reach: Enter runs the first
              action in it and Space the second. So a folder's are "go in, then
              open it", and a file's is *only* "open it" — pressing open on a
              file has to launch the file, in Blender or whatever else claims
              it, and never hand its folder to a file manager instead. Revealing
              is a real action, but it belongs in the next section down with a
              shortcut of its own. */}
          <ActionPanel.Section>
            {hit.directory ? (
              <>
                <Action title="Enter Folder" icon={Icon.ArrowRight} onAction={() => onEnter(hit)} />
                <Action
                  title="Open in File Manager"
                  icon={Icon.Folder}
                  onAction={() => handOff(hit.path)}
                />
              </>
            ) : (
              <Action title="Open" icon={Icon.Document} onAction={() => handOff(hit.path)} />
            )}
            {/* No `Action.OpenWith`: there is no app chooser on this platform, so
                the shim degrades it to a plain open — which here would be a
                second row labelled "Open" doing what the first one does. */}
          </ActionPanel.Section>
          <ActionPanel.Section>
            {!hit.directory && (
              <Action
                title="Open Containing Folder"
                icon={Icon.Folder}
                shortcut={{ modifiers: ['ctrl'], key: 'o' }}
                onAction={() => handOff(dirname(hit.path))}
              />
            )}
            <Action
              title="Open in Terminal"
              icon={Icon.Terminal}
              shortcut={{ modifiers: ['ctrl'], key: 't' }}
              onAction={() => openTerminal(hit.directory ? hit.path : dirname(hit.path))}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.CopyToClipboard
              title="Copy Path"
              content={hit.path}
              shortcut={{ modifiers: ['ctrl'], key: 'c' }}
            />
            <Action.CopyToClipboard title="Copy Name" content={hit.name} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  )
}

/** Directories first, then by name — the order every file manager lists in. */
function listDirectory(path: string, hidden: boolean): { hits: Hit[]; problem: string | null } {
  try {
    const hits = readdirSync(path, { withFileTypes: true })
      .filter((entry) => hidden || !entry.name.startsWith('.'))
      .map((entry) => {
        const full = join(path, entry.name)
        // `isDirectory()` is false for a symlink *to* a directory, and a symlink
        // to a directory is a directory as far as anyone browsing is concerned.
        let directory = entry.isDirectory()
        if (!directory && entry.isSymbolicLink()) {
          try {
            directory = existsSync(full) && lstatSync(full).isDirectory()
          } catch {
            directory = false
          }
        }
        return { path: full, name: entry.name, directory, executable: isExecutable(full, directory) }
      })
      .sort((a, b) =>
        a.directory === b.directory
          ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          : a.directory
            ? -1
            : 1
      )
    return { hits, problem: null }
  } catch (error) {
    return { hits: [], problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A folder, listed.
 *
 * Pushed rather than swapped in, so the launcher's own Back key walks the
 * directories: one Esc is one folder up, which is the behaviour the key already
 * promises everywhere else in the panel. A `cwd` in state would have needed its
 * own key for the same job and would have made Esc jump all the way out.
 *
 * Filtering is the **launcher's**, not ours: a listing is a fixed list, so the
 * search box narrows it with the same rules — and the same forgiven typo — that
 * the root list uses. That is CLAUDE.md's rule that a plugin view is part of the
 * launcher rather than a separate app, and it is free here.
 */
function Browse({
  path,
  home,
  hidden,
  hideOnOpen
}: {
  path: string
  home: string
  hidden: boolean
  hideOnOpen: boolean
}): React.JSX.Element {
  const { push } = useNavigation()
  const { hits, problem } = useMemo(() => listDirectory(path, hidden), [path, hidden])

  const enter = (hit: Hit): void => {
    push(<Browse path={hit.path} home={home} hidden={hidden} hideOnOpen={hideOnOpen} />)
    // The box keeps its text across a push, so without this the folder you just
    // opened would arrive filtered by whatever you typed to find it.
    void clearSearchBar()
  }

  return (
    <List navigationTitle={tilde(path, home)} searchBarPlaceholder={`Filter ${basename(path) || path}`}>
      {problem !== null ? (
        <List.EmptyView icon={Icon.ExclamationMark} title="Cannot open this folder" description={problem} />
      ) : hits.length === 0 ? (
        <List.EmptyView
          icon={Icon.Folder}
          title="Empty"
          description={hidden ? 'Nothing in here.' : 'Nothing in here - hidden files are off in this plugin’s preferences.'}
        />
      ) : (
        hits.map((hit) => (
          <Row key={hit.path} hit={hit} home={home} hideOnOpen={hideOnOpen} onEnter={enter} />
        ))
      )}
    </List>
  )
}

// ─── the view ───────────────────────────────────────────────────────────────

export default function SearchFiles(): React.JSX.Element {
  const preferences = getPreferenceValues<Preferences>()
  const home = homedir()
  const { push } = useNavigation()
  const hidden = preferences.showHidden === true

  const tool = useMemo(() => pickTool(preferences.tool), [preferences.tool])
  // Read once per open rather than per keystroke, and re-read on the next open:
  // the settings menu writes `config.toml` and this view is short-lived, so
  // "when it opens" is as live as a watcher would be.
  const settings = useMemo(() => configuredSettings(), [])
  const order = settings.order

  // A folder found by searching opens the same way a folder found by browsing
  // does — one view per directory, so Esc walks back up through them.
  const enter = (hit: Hit): void => {
    push(
      <Browse path={hit.path} home={home} hidden={hidden} hideOnOpen={settings.hideOnOpen} />
    )
    void clearSearchBar()
  }

  const [query, setQuery] = useState('')

  // Home and everything under it, always. There is no scope to choose and no
  // launch context to honour — see the note at the top.
  const root = home
  const trimmed = useDebounced(query.trim(), DEBOUNCE_MS)

  const { data, isLoading, error } = useExec(
    tool?.path ?? 'true',
    tool === null ? [] : argsFor(tool, trimmed, root, preferences.showHidden === true),
    {
      // Nothing typed is not a search: an empty pattern matches every file on
      // the machine, and the view would open by walking your home directory.
      execute: tool !== null && trimmed.length > 0,
      keepPreviousData: true,
      timeout: TIMEOUT_MS,
      // A tool with no matches exits non-zero, and that is not an error — it is
      // the answer. Only a real failure should reach the error branch.
      parseOutput: ({ stdout, stderr, exitCode }) => {
        if (exitCode !== 0 && String(stdout).length === 0 && String(stderr).trim().length > 0) {
          throw new Error(String(stderr).trim().split('\n')[0])
        }
        return String(stdout)
      }
    }
  )

  const hits = useMemo(() => {
    if (data === undefined || trimmed.length === 0) return []
    const paths = String(data)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // `locate` cannot be scoped, so the scope is applied here. It is also what
      // drops entries for files that have been deleted since the last updatedb.
      .filter((line) => line === root || line.startsWith(`${root}${sep}`))
      .slice(0, LIMIT)

    const found: Hit[] = []
    for (const path of paths) {
      let directory = false
      let executable = false
      try {
        const stats = lstatSync(path)
        directory = stats.isDirectory()
        executable = !directory && (stats.mode & EXECUTABLE_BIT) !== 0
      } catch {
        // Gone between the tool listing it and us asking. Skip it rather than
        // offer a row whose Enter can only fail.
        continue
      }
      found.push({ path, name: basename(path), directory, executable })
    }
    return rank(found, trimmed, order, home)
  }, [data, trimmed, root, order, home])

  if (tool === null) {
    return (
      <List searchBarPlaceholder="Search Files">
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="Nothing to search with"
          description={
            'Install fd (recommended), plocate, or findutils, and reopen this. ' +
            'On Arch: pacman -S fd · Debian/Ubuntu: apt install fd-find · Fedora: dnf install fd-find'
          }
        />
      </List>
    )
  }

  return (
    <List
      // Loading from the first keystroke, not from the first spawn: between the
      // two there is a debounce, and a list that says nothing during it reads as
      // a search that found nothing.
      isLoading={isLoading || query.trim() !== trimmed}
      // The plugin owns the query: it is a filesystem search, not a filter over
      // a list we already have, so every keystroke is a new search rather than a
      // narrowing of the last one's results.
      filtering={false}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search Files"
    >
      {/* Nothing typed draws nothing at all — no hint, no empty state. This is a
          search bar, and a search bar with a paragraph under it is a dialog. The
          panel is exactly as tall as the bar until there is something to show,
          which is what the launcher's own root list does and the shape people
          already know. */}
      {trimmed.length === 0 ? null : error !== undefined ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title={`${tool.name} could not run this search`}
          description={
            tool.name === 'locate'
              ? `${error.message} - plocate answers from a database; run updatedb, or switch this plugin's "Search With" to fd.`
              : error.message
          }
        />
      ) : (
        /* One section per category, in the configured order, so the ordering is
           something you can see rather than infer. Sections with nothing in them
           are not rendered — an empty "3D Files" heading is a heading that
           answers a question nobody asked. */
        sectioned(hits, order).map(([category, rows]) => (
          <List.Section key={category} title={CATEGORY_TITLES[category]}>
            {rows.map((hit) => (
              <Row
                key={hit.path}
                hit={hit}
                home={home}
                hideOnOpen={settings.hideOnOpen}
                onEnter={enter}
              />
            ))}
          </List.Section>
        ))
      )}
    </List>
  )
}

/** The ranked hits, grouped into their categories without reordering them. */
function sectioned(
  hits: readonly Hit[],
  order: readonly Category[]
): readonly [Category, readonly Hit[]][] {
  const groups = new Map<Category, Hit[]>()
  for (const hit of hits) {
    const category = categoryOf(hit)
    groups.set(category, [...(groups.get(category) ?? []), hit])
  }
  return order.flatMap((category) => {
    const rows = groups.get(category)
    return rows === undefined || rows.length === 0 ? [] : [[category, rows] as [Category, Hit[]]]
  })
}
