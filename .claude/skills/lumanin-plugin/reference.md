# The `lumanin` plugin API - what exists today

Everything a plugin can reach comes from one module:

```tsx
import { List, ActionPanel, Action, showToast, Toast, usePromise } from 'lumanin'
```

This file is the ground truth for what that module provides **right now**. If something is not
listed as working here, do not emit it. (Maintainers: this file is updated alongside the api-shim.)

## A plugin's shape

```
my-plugin/
  package.json        # the manifest
  src/
    <command>.tsx     # one entry file per command, named after commands[].name
  assets/             # optional; icons and images, copied on install
```

The manifest (`package.json`):

```json
{
  "name": "my-plugin",
  "title": "My Plugin",
  "description": "One sentence about what it does.",
  "author": "you",
  "license": "MIT",
  "commands": [
    {
      "name": "search", "title": "Search Things", "description": "…", "mode": "view",
      "lumanin": { "categories": [{ "id": "things", "title": "Things" }] }
    }
  ],
  "preferences": []
}
```

- **Required**: `name`, and at least one command with a `name`. Everything else has a sane
  default, but always set `title`, `description` and `author` - they are what the user sees at
  install time.
- `commands[].mode`: `"view"` (renders UI; the entry file default-exports a React component) or
  `"no-view"` (runs and exits; the entry file default-exports an async function - good for "do
  the thing and show a HUD").
- `commands[].name` **is** the entry filename: `"name": "search"` → `src/search.tsx`.
- `preferences[]` (top-level or per-command): `{ name, title, description, type, required,
  default }` with `type` one of `textfield`, `password`, `checkbox`, `dropdown` (with
  `data: [{title, value}]`), `appPicker`, `file`, `directory`. The user edits them in
  `lumanin plugins`; the plugin reads them with `getPreferenceValues()`.
- `dependencies`: keep empty (see SKILL.md step 3). The runtime provides `lumanin` and React.
- Do **not** declare `commands[].arguments` expecting input - the launcher has no argument input
  UI yet; `LaunchProps.arguments` is always `{}`.
- `icon` (top-level, or per-command - the command's wins): what the command's root-list row is
  drawn with. Three forms:
  - `"search:<name>[,<fallback>…]"` - the desktop's own icon for the application the plugin
    fronts, with the launcher's three-dot search mark drawn over it by the launcher itself.
    **What every app-connected "Search X" command declares.** The names are freedesktop icon
    names: take the `Icon=` line of the app's `.desktop` file, and add a sensible fallback after
    a comma. Ship no image - the mark is the launcher's, identical on every search row, and the
    base icon is whatever the user's icon theme says the app looks like.
  - `"system:<name>[,<fallback>…]"` - a theme icon, unmarked. For a command that *is* a thing
    the desktop has an icon for but is not a search of an app.
  - a filename - a file in `assets/` (SVG preferred). **What a standalone plugin ships**: its
    own identity, designed per SKILL.md step 2.
  Without one the row shows a plain glyph, and an icon the theme cannot resolve degrades to the
  same glyph - never a broken image. This field is the *root row's* face; icons inside the view
  are the `List.Item` `icon` props below.
- `commands[].lumanin.categories`: the command's categories, `{ id, title }` with ids matching
  `[a-z0-9-]+`. Declared statically so `lumanin config` can offer them for pinning and hotkeys
  without running the plugin. Wire them to a `List.Dropdown`, start it on
  `launchContext.category` when that value is one of the declared ids and on the first id
  otherwise, and give every `List.Item` a stable `id` - that id is what a pinned item names, and
  the launcher preselects the matching row on such a launch. Without that check an unknown value
  shows the first category's title over an empty list. SKILL.md step 2 has the worked pattern;
  `example/` implements it.
- `commands[].lumanin.root`: leave it alone. `false` means "this command is not on the root list at
  all" - no row, no pin, no alias - and exists for the launcher's *own* surfaces, which have a
  hotkey of their own instead (file search is the only one). A plugin someone installs exists to be
  found by typing its name, so setting this is setting it to unreachable.
- **Ids and action titles are a public surface.** A user can pin, alias or bind a key to a
  category, a single row (`id`), or a single **action on a row** - and an action is named by its
  `title`, since the API gives it no id. Both must therefore be stable between runs, and an action
  title must not contain `!` (the character that separates an action from its row in the key the
  launcher writes). A key bound to an action runs it **headless - no window at all**: the plugin
  renders offscreen, the row is found by id, the action's handler is dispatched. Anything
  destructive still needs `confirmAlert`, which works there too.

## Works today

**Components**
- `List` - `List.Item` (title, subtitle, icon, keywords, accessories: text/date/tag/icon with
  colour), `List.Section`, `List.EmptyView`, `List.Dropdown` (+ `.Item`, `.Section`) as
  `searchBarAccessory`, `List.Item.Detail` side panel via `isShowingDetail`. Props: `isLoading`,
  `filtering`, `searchBarPlaceholder`, `onSearchTextChange`, `onSelectionChange`.
  Built-in filtering matches the way the launcher's root search does: the item's **title** plus
  its explicit `keywords` (one forgiven typo, title matches ranked first) and **never the
  subtitle** - so the name goes in `title` and descriptions never double as search terms.
- `Detail` - markdown (rendered natively, never as HTML - a `<script>` in markdown is drawn as
  text), plus `Detail.Metadata` with `Label`, `Link`, `TagList`, `Separator`.
- `ActionPanel` - `.Section`, `.Submenu` (a real nested level in the Ctrl+K panel).
- `Action` and its variants: `Action.CopyToClipboard`, `.OpenInBrowser`, `.Open`, `.OpenWith`,
  `.Push`, `.Pop`, `.Paste`, `.Trash`. Keyboard `shortcut`s in both spec shapes; `cmd` maps to
  Ctrl automatically. **Do not offer `.Open` and `.OpenWith` on the same row** - there is no app
  chooser on this platform, so `.OpenWith` opens with the default handler and is titled `Open`
  like the other one. Two identical rows in the panel, which is worse than one.
- `Icon.*` (the full enum), `Color.*`, `Image` masks and tinting.
- **`icon="system:<name>[,<fallback>…]"` - an icon from the desktop's own icon theme.** Lumanin's
  own addition to the source shapes an `Image` accepts, and the only one: the names are
  freedesktop icon names (`folder`, `text-x-python`, `image-x-generic`, `firefox`), resolved
  against whatever theme the session is set to - Breeze on KDE, Adwaita on GNOME, Papirus if that
  is what is installed. Use it whenever the row *is* a thing the desktop already has an icon for
  (a file, a folder, an application, a device); the result looks like the file manager next to it
  instead of like a glyph set. Names are tried in order, so name the specific one first and a
  generic one after it - a theme is free to ship any subset, and `text-x-generic` is a better
  answer than a blank square.
- **Rows that are websites get `getFavicon(url)`** (from `lumanin`): the site's own favicon,
  fetched from the site itself over TLS, cached, degrading to a glyph when the site has none.
  A bookmark or history list shows each site's face this way - never one repeated bookmark
  glyph. Per-row icons beat one list-wide icon wherever the data has faces of its own.

**The order of your actions is a keyboard layout, and `ActionPanel.Section` is where it stops.**
The launcher binds its `open` key (Enter) to the **first** action in the panel, and its `secondary`
key (Space while the search box is empty, Ctrl+Enter once it is not) to the **second action in that
same section** - falling back to the first where the section holds only one. So put the verbs that
are alternatives to each other in the first section, and everything else below it with a `shortcut`
of its own.

Search Files is the worked example. A folder's first section is *Enter Folder* then *Open in File
Manager*, so Enter goes in and Space opens it. A file's first section is *Open* **alone**, so both
keys launch the file - and *Open Containing Folder* sits in the next section on `Ctrl+O`,
because "open this file" and "show me its folder" are not two ways of doing one thing, and a user
who presses open on a `.blend` wants Blender, not a file manager.

Both keys are rebindable by the user (`config.toml` `[keys]`), so name your actions for what they
do, not for the key you expect.

**Shortcuts are Ctrl + one key. No Shift** (project rule) - write
`{ modifiers: ['cmd'], key: 'o' }`, which maps to Ctrl+O, and not `['cmd', 'shift']`. A launcher is
used one-handed while something else has your attention, and a three-key chord is not that. Reach
for Ctrl+Alt only when a plugin genuinely has more actions than there are free letters, and use
Shift only if the user asks for it by name. `Keyboard.Shortcut.Common.*` is the spec's own table and
still contains Shift in places - prefer writing the chord out to importing one of those.

**Functions and objects**
- `showToast` / `Toast` - three styles, mutable after creation, primary/secondary actions.
- `showHUD`, `confirmAlert` + `Alert` (a real modal; your code awaits the answer).
- `useNavigation` - `push`/`pop`; Esc pops; every stack entry stays mounted. **This is how you
  build a drill-down**: one view per level (a folder, a project, a category) means the launcher's
  own Back key walks back up one level at a time, which a `cwd` in state cannot do - Esc there
  drops the user out of your plugin entirely. Call `clearSearchBar()` after `push` unless you want
  the new view arriving filtered by whatever the user typed to reach it.
- `LocalStorage` (`getItem`/`setItem`/`removeItem`/`allItems`/`clear`), `Cache` (sync API).
- `getPreferenceValues()`, `environment` (incl. `environment.canAccess(...)` for feature
  detection, `supportPath` for a writable per-plugin directory), `LaunchProps`.
- `Clipboard.copy` / `.paste` / `.read` / `.readText` / `.clear`.
- `open(target)`, `trash(path)`, `getApplications()`, `getDefaultApplication()`.
- `getFrontmostApplication()` - the focused window's application. Answered on Hyprland, Sway and
  X11; rejects on desktops that do not expose the window list, so catch it and degrade.
- `updateCommandMetadata({ subtitle })` - sets the subtitle of the command's own root-list row.
- `closeMainWindow()`, `popToRoot()`, `clearSearchBar()`, `getSelectedText()` (from the desktop's
  primary selection, where the platform supports it), `captureException` (local log only).

**Hooks (data loading)**
- `usePromise`, `useCachedPromise`, `useCachedState`, `useLocalStorage`, `useFetch`,
  `showFailureToast`, `getAvatarIcon` (generated locally), `getFavicon` (asks only the site
  itself), `getProgressIcon`.
- **`useExec(file, args?, options?)`** - run a program, render its output. Reach for this before
  writing `child_process` by hand: it gives you loading, errors, cancellation of a superseded run,
  and the last value kept between runs, which is why a plugin opens showing yesterday's list
  instead of an empty panel.
  ```tsx
  const { isLoading, data } = useExec('systemctl', ['list-units', '--output=json'])
  const units = useMemo(() => JSON.parse(data ?? '[]'), [data])
  ```
  **Pass arguments as an array.** `useExec('git status')` also works and splits on spaces (a
  backslash escapes a space; nothing else needs quoting), but the array form needs no quoting and
  cannot be re-parsed - and a query interpolated into a command line is how a plugin ends up
  running something its author did not write. `shell: true` exists for `&&` and pipes; it is the
  one place that risk comes back, so use it only when the line genuinely needs a shell.
  Options: `cwd`, `env`, `input`, `timeout` (default 10 s), `encoding: 'buffer'`, `parseOutput`
  (which also receives failures instead of them being thrown).

**Forms**
- **`Form`** with `Form.TextField`, `TextArea`, `PasswordField`, `Checkbox`, `Dropdown` (+`.Item`,
  `.Section`), `TagPicker` (+`.Item`), `DatePicker`, `FilePicker`, `Description`, `Separator`.
  `LinkAccessory`. `error`, `info`, `autoFocus`, `onBlur`/`onFocus`, and refs with `.focus()` / `.reset()`.
- `Action.SubmitForm` receives every field's value keyed by its `id`, in the type its control
  holds: string, boolean, `string[]` for a tag picker or file picker, `Date` for a date picker.
  **Give every field an `id`** - a field without one submits nothing and cannot be focused.
- Validation is yours: check inside `onSubmit` and set the field's `error` prop. Enter submits from
  anywhere except a text area, which keeps Enter for newlines.

**Launching another command**
- `launchCommand({ name, type, context })` - a sibling command by `name`, or somebody else's with
  `extensionName` too. `context` arrives as the target's `launchContext`, the same field a pinned
  category arrives in, so a command written for one is already written for the other.
  `type: LaunchType.Background` runs it with no window at all.

## Not yet - renders a card or throws with a message; do not emit

- **`Grid`** and **`MenuBarExtra`** - they render a "not supported yet" card. Use a `List` with
  icons instead of a `Grid`; there is no substitute for a menu bar extra.
- `openCommandPreferences` / `openExtensionPreferences` - throw; tell users to run
  `lumanin plugins` instead.
- `useForm` - `Form` itself is real, but this helper is not; manage the values with `useState` and
  set each field's `error` prop yourself.
- `useSQL`, `executeSQL`, `useStreamJSON`, `useFrecencySorting`, `withCache`.
- `Action.PickDate` - use a `Form.DatePicker` on a form instead.
- `Action.CreateQuicklink`, `Action.CreateSnippet` - render, then throw when pressed: the launcher
  has no quicklink or snippet store.
- `createDeeplink` and friends - there is no `lumanin://` URL to build. To let something outside
  the launcher trigger a command, the user pins it or binds it and runs
  `lumanin open '<key>'`.
- **OAuth - and this one is never coming.** `OAuth.PKCEClient`, `OAuthService`,
  `withAccessToken`, `getAccessToken` all throw. Lumanin runs no online services and does not
  broker sign-in. **If the tool needs a token, declare a `password` preference and read it with
  `getPreferenceValues()`** - the user pastes one in `lumanin plugins`, it never leaves their
  machine, and revoking it is deleting it:
  ```json
  "preferences": [
    { "name": "token", "type": "password", "required": true,
      "title": "API token", "description": "Create one at <the tool's settings page>" }
  ]
  ```
  Say in the `description` exactly where the user gets one. If the service issues *only* OAuth
  credentials and has no personal access tokens at all, say so plainly and stop - that plugin
  cannot be built here, and a half-working one is worse than none.
- AI: `AI.ask`, `useAI` - throw. No AI provider ships with Lumanin and there is no setting for one.
- Background refresh: `commands[].interval` is parsed but nothing schedules it yet.
- macOS-only, will never work here: `runAppleScript`, `runPowerShellScript`, `showInFinder`,
  `getSelectedFinderItems`, `Action.ShowInFinder`, `Action.ToggleQuickLook`. Also never here:
  `BrowserExtension` (needs a companion browser extension Lumanin does not ship),
  `Action.InstallMCPServer`, `WindowManagement.*` (your window manager's job). Never write
  macOS-specific paths (`/Applications`, `~/Library`) or shell out to `osascript`/`pbcopy` -
  this is Linux; use the APIs above or standard Linux tools.

## Gotchas

- `List`'s `throttle` is honoured: the typed text reaches `onSearchTextChange` as a 150 ms
  trailing debounce, so a burst of keystrokes is one call carrying the last of them. An emptied
  search box still arrives at once - cancelling is never worth waiting for. Set it whenever a
  query costs a process or a request: typing six letters would otherwise start six searches and
  the first one, on a single letter, is the slowest of them. Hold `isLoading` true while you
  wait for an answer, or the list reads as a search that found nothing - that part is still
  yours to do.
- Superseding a run is handled for you. `execute: false` aborts the run in flight and discards
  its result, so clearing the box stops the work rather than letting it finish into a query the
  user has left; and a run that fails after a newer one started raises no toast and calls no
  `onError`. `useExec` re-runs whenever `input`, `env`, `shell` or `cwd` change, not only on the
  command and its arguments.
- `pagination` is parsed but `onLoadMore` never fires - show your first page.
- `List.Dropdown`'s `storeValue` does not persist across launches yet; `defaultValue` does fire
  `onChange` on mount, so gate initial loads on that. The launcher's Tab key cycles the dropdown
  to its next entry (rebindable under `[keys] category`), so never bind Tab yourself.
- Spawning processes: always `execFile(cmd, [args])` / `spawn(cmd, [args])` with argv arrays -
  never `exec("cmd " + userInput)`. User-controlled text goes in an argv element or stdin, never
  interpolated into a shell line.
- `fetch`, `AbortController`, `URL` are global (modern Node) - no polyfills, no packages.
- The plugin runs in a worker with a 512 MB ceiling; a crash shows an error card and the
  launcher survives, but treat that as a failure you fix, not a safety net.

## The loop

```sh
lumanin plugin-install <dir>   # build + install; errors surface here
lumanin ext dev <dir>          # watch mode: rebuild + reload on save
lumanin ext list               # what is installed, and from where
lumanin plugins                # user-side: disable commands, set preferences
lumanin plugin-export <name>   # installed plugin → ~/Downloads, ready to publish
```
