---
name: lumanin-plugin
description: Generate a Lumanin launcher plugin. Use when the user wants a new plugin, extension, or command for Lumanin - "make me a plugin for X", "I want to search my Y from the launcher", "add a Lumanin command that does Z".
---

# Writing a Lumanin plugin

You are generating a plugin for Lumanin, a keyboard-first launcher for Linux. A plugin is a
directory with a `package.json` and a `src/`, written in TypeScript and React against the
`lumanin` module. `reference.md` in this folder is the complete API surface - read it before
writing any code, and do not use anything it lists as *not yet available*. `example/` is a
complete, working plugin; match its shape and style.

Follow these five steps in order.

## 1. Interview, in plain words

Ask what the plugin should do, in the user's own terms. Then work out - and say out loud - which
parts of that live **on this machine** and which would need the internet.

**Local first is a rule, not a preference.** If there is any fully local way to get the data,
use it, even when a web API looks more direct - and before concluding there is none, actively
hunt for workarounds:

- a CLI the app ships (`op`, `docker`, `gh`, `systemctl`, `pacman`, `hyprctl`, `journalctl`,
  project scripts…) - check `--help` and man pages for a JSON output flag,
- files the app leaves behind: SQLite databases, JSON/TOML config, caches, logs under
  `~/.config`, `~/.local/share`, `~/.cache`,
- local sockets and D-Bus services the app already exposes,
- a locally running server the app itself talks to (many desktop apps front a localhost port).

Only when none of those can carry the feature does the network become the plan - and then it
goes through the consent rules in step 3. The best Lumanin plugins are the ones no one else
will ever write: they are about *this* computer.

Keep questions short and few. One command doing one thing well beats a suite.

Do not only ask - **probe**. Before designing anything, run the commands the plugin will lean on
(`op item list`, `docker ps`, `systemctl --user list-units`…) and look at the real output: it
tells you the output format, and it tells you *now* whether the tool is installed and set up.
A missing or unconfigured tool is your problem to solve (step 4), not a surprise to ship.

## 2. Design within the supported surface

**Work that outlives the panel.** An awaited `onAction` keeps its worker alive after the panel
hides, up to 90 seconds, so `await closeMainWindow()` followed by the real work is a supported
shape. Anything that may run longer goes in a detached child process. Report the outcome with
`showHUD` before closing or write it to `LocalStorage`: a hidden panel shows no toast.

**A plugin is part of the launcher, not a separate app.** It inherits Lumanin's conventions and
you do not re-invent them unless the user explicitly asks for different behaviour:

- **Search is the launcher's search.** The built-in `List` filtering already matches the way the
  root list does - against the item's **title** (plus explicit `keywords`), one forgiven typo,
  never the subtitle. So: put the thing's *name* in `title`, description in `subtitle`, and add
  `keywords` only for terms someone would genuinely type. Do not reach for `onSearchTextChange`
  to build custom matching - that is for when the query drives a computation (an API call, a
  calculation), or when the user has asked for different search rules.
- **Keys are the launcher's keys.** Enter runs the first action in the panel's first section,
  Space (or Ctrl+Enter while typing) runs the second one in that same section, `Ctrl+K` opens the
  action panel, Esc backs out one level, and Tab switches the category dropdown to its next
  entry - which is why must-have 3 wires one up: the categories are on a key, not just a mouse
  target. Order your actions accordingly - that order *is* what the
  two keys do - and put anything that is not an alternative to the first action in a later
  `ActionPanel.Section`. Do not assign custom shortcuts that shadow these (Tab included), and do not add a
  shortcut for something that is already the primary action.
- **Shortcuts are Ctrl + one key. No Shift.** `{ modifiers: ['cmd'], key: 'o' }` → Ctrl+O. A
  launcher is used one-handed while your attention is on something else, and a three-key chord is
  not that. Ctrl+Alt only if a plugin really runs out of letters; Shift only if the user asks for
  it by name.
- **Looks are the launcher's theme.** Colours come from `Color.*`, icons from `Icon.*` - never
  hard-coded hex, never ASCII-art layouts inside titles.
- **Every row wears its own face, not the list's.** One icon repeated down the whole list is a
  wasted column; when the data names something that has its own image, use it per item. A row
  that is a website gets `getFavicon(url)` (a bookmark list shows each site's favicon, not a
  bookmark glyph). A row that is a file gets its type's theme icon (`system:text-x-python`,
  `system:image-x-generic`). A row that is an application gets that app's theme icon
  (`system:firefox`). Fall back to one `Icon.*` glyph only where the data genuinely has no face
  of its own - and let a failed favicon degrade to that glyph rather than a broken image.
- **An icon is data: read it every time, never remember it.** When the thing a row stands for
  changes its image (a Godot project gets a new `icon.png`, a bookmark a new favicon), the row
  shows the new one on its next load, with no cache to clear and no cap that quietly turns a big
  image into a glyph. An image file goes into the plugin's own `environment.assetsPath` under a
  cache directory, named by its content hash, and the row's `icon` is that relative path - the
  launcher serves it from disk, a changed image is a new name, and a pin of the row keeps
  working. Inline a `data:` URI only for something small (a few KB of SVG); never push a large
  image through the render tree, and never drop to an `Icon.*` glyph for an image that exists.
- **No em dashes, anywhere a person reads.** Titles, subtitles, toasts, empty states, README
  text, code comments - a plain `-` with spaces around it does the job. This applies to the
  plugin you generate and to everything you write while generating it.

**An app-connected plugin - one that fronts another program - is a "Search X" with categories.
These six are must-haves, not suggestions:**

1. One **view command titled "Search \<App\>"** is the front door; the app's things live inside
   it, never as separate root commands.
2. **Declare its categories in the manifest** (`commands[].lumanin.categories`, ids
   `[a-z0-9-]+`): 1Password → Logins, Credit Cards, Identities; Discord → Friends, Group chats,
   Channels. One category is fine; invented filler is not.
3. **Wire a `List.Dropdown`** (`searchBarAccessory`) to those categories, and start it on
   `launchContext.category` - that is how a pinned category or a hotkey opens the plugin
   already inside the right one. Take that value only when it is one of the ids you declared:
   a pin written before a category was renamed has to open the plugin, not leave an empty list
   under the wrong title.
   ```tsx
   const CATEGORIES = [
     { id: 'logins', title: 'Logins' },
     { id: 'credit-cards', title: 'Credit Cards' },
     { id: 'identities', title: 'Identities' }
   ] as const

   // inside the command component
   const requested = props.launchContext?.category
   const [category, setCategory] = useState(
     typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
       ? requested
       : 'logins'
   )
   ```
4. **Give every `List.Item` a stable `id`.** It is what lets the user pin a single thing -
   one login, one friend - from `lumanin config`; a row without an id cannot be pinned, bound
   to a key, or aliased. Stable means stable *across runs*: derive it from the thing's own
   identity (a path, a uuid, a slug), never from the row's position. The row's `icon` travels
   with the pin: a theme name, an asset, a URL or an inline image all draw at the root as they do
   in the list, while an `Icon.*` glyph does not, so a row someone might pin wants a real image.

5. **Keep action titles stable too, and free of `!`.** A key can be bound straight to one action
   on one row - "Dawnline → Open project" - and an action's *title* is the only name it has to
   be bound by; the API gives an action no id, and its handler is minted afresh every render.
   Renaming "Open project" to "Open Project" breaks every key and alias pointing at it, and a
   title containing `!` cannot be named at all (that character separates the action from its row
   in a pin key). Write the title once and leave it alone.

6. **Stamp the manifest icon: `"icon": "search:<icon-name>[,<fallback>]"`** on the Search
   command. The launcher resolves the name against the desktop's icon theme and draws its
   three-dot search mark over it - Godot's logo under the dots is what says "a search of Godot,
   not Godot" at the root. Probe for the name, never guess it: read the `Icon=` line of the
   app's `.desktop` file (`grep -h '^Icon=' ~/.local/share/applications/*.desktop
   /usr/share/applications/*.desktop | grep -i <app>`), use that as the first name and a likely
   alternative as the fallback. Ship no image for this - the mark is the launcher's, so every
   search row wears the identical one.

Also worth knowing while you design the actions: **an action bound to a key runs with no window**.
The plugin renders headless, the action's handler is dispatched, and nothing is shown - so the
first action of a row should be the one that *does the obvious thing*, and anything destructive
still belongs behind `confirmAlert` - but in that headless run the alert is auto-dismissed
(`confirmAlert` resolves `false`, the destructive branch is skipped) and the launcher shows a
notice telling the user to run the action from the launcher window instead.

`example/` does all of this. Users reach every level from one browser in `lumanin config` -
Plugins → plugin → command → category → row → action - to pin it, bind a key to it, or alias it,
and set a per-plugin alias in `lumanin plugins`. The plugin's only job is the contract above.

Note also that a plugin's **commands** appear in the root list on their own - `plugins` is the
first result group by default, so "Search Godot Projects" comes up above the Godot application
for the query "godot". That is exactly why the command's title should name the thing it fronts.

**Every plugin gets an icon; a bare glyph at the root is a missing one.** Which kind is decided
by what the plugin is:

- **App-connected**: must-have 6 above - the target application's own icon under the launcher's
  search mark. Never draw one of these yourself.
- **Standalone** (no application behind it - a calculator, a systemd browser, a note tool):
  **design one, every time, and a different one every time.** Write `assets/icon.svg` by hand -
  flat and minimal, two or three geometric shapes on a plain ground, no text, no gradients, no
  strokes thinner than 4 units - with the shapes invented from *this plugin's* subject: a unit
  browser might be a column of three bars with one highlighted, a dice roller a tilted square
  with pips. Never reuse a composition you have drawn before, never imitate the launcher's
  three-dot search mark (that mark means "a search of an app" and is stamped by the launcher
  only), and never trace another product's logo. Two colours, mid-saturation so they read on
  dark and light themes alike; `viewBox="0 0 128 128"`; rounded corners in keeping with a flat
  terminal aesthetic. Then point the manifest at it: `"icon": "icon.svg"`.

- Pick components only from `reference.md`. **Never emit `Grid` or `MenuBarExtra`** - they render
  a "not supported yet" card today. A `List` with icons replaces a `Grid`.
- Input mechanisms that actually exist today, in order of preference:
  1. the **search bar** - `List` filtering (free) or `onSearchTextChange` (you handle it),
  2. **preferences** - declared in the manifest, read with `getPreferenceValues()`, edited by the
     user in `lumanin plugins`; right for API keys, paths, and choices that rarely change,
  3. **`List.Dropdown`** as `searchBarAccessory` - right for a mode/category switch,
  4. a **`Form`**, for anything a person has to type or choose that is not a search: "Create",
     "Add", "Rename", "Send". Give every field an `id`, put the values together in
     `Action.SubmitForm`'s `onSubmit`, and set a field's `error` prop rather than showing a toast
     - an error belongs on the field that is wrong. Reach the form from a `Search X` list with a
     `push`, so the plugin still has one front door.
  Do **not** design around command `arguments[]`: the manifest field parses, but the launcher has
  no input UI for it yet, so `LaunchProps.arguments` is always empty.
- Put a `confirmAlert` in front of every destructive action (stop, delete, kill, overwrite).
- Report outcomes with `showToast` (success and failure styles), long output with a pushed
  `Detail` view.
- **Run programs with `useExec`**, not with `child_process` by hand - it is the hook a Linux
  plugin needs most, and it brings loading state, error handling, cancellation of a superseded run,
  and a value that survives the command closing. Pass **argv arrays, never a concatenated shell
  string**: a query interpolated into a command line is how a plugin runs something its author did
  not write. Where you do need `execFile`/`spawn` directly (a long-lived process, a stream), the
  argv rule is the same - see `example/src/units.tsx` for the pattern.
- **Make typing cheap - these four rules apply to every plugin, not just the slow ones.**
  1. Set `throttle` on any `List` whose `onSearchTextChange` starts a process or a request. The
     launcher delivers the text as a 150 ms trailing debounce, so a burst of keystrokes becomes
     one search instead of six; without it every letter spawns and kills a run. A plugin that
     filters a list it already holds does not need it - built-in filtering is free.
  2. Gate the hook on having something to search: `execute: searchText.length > 0`. Turning
     `execute` off aborts the run in flight (with `useExec` the child process is killed), so an
     emptied search box stops work instead of waiting out a timeout. For `usePromise`/`useFetch`
     pass an `abortable` ref too, or the discarded run keeps computing to completion.
  3. Feed the query through `args` or `input` (stdin) and let the hook re-run on the change -
     `useExec` re-executes whenever `file`, `args`, `input`, `env`, `shell` or `cwd` change.
     Never debounce or supersede by hand; the launcher already does both, and doing it twice
     adds latency.
  4. Render `data ?? []` and keep `isLoading` honest while a run is out. The hooks keep the
     previous answer visible while the next one loads, so rows update in place instead of
     flashing empty - blanking the list yourself defeats that.
  Give every `List.Item` a stable `id` (all plugins, not only app-connected ones): a stable id
  is what lets a row keep its identity across updates, so an unchanged row is not re-rendered
  and the selection does not jump when results refresh.

## 3. Dependencies and the network - the rules

**Default: `dependencies` is empty.** The runtime provides `lumanin` and React; Node's builtins
provide everything else a local plugin needs. A plugin with zero dependencies installs instantly,
works offline, and can be read top to bottom by the person trusting it. This is the default and
you do not deviate from it silently.

**If the plugin's purpose needs the internet** (a weather panel, an API client) - and step 1
found no local route to the same data: use the built-in
`fetch` - still zero packages. Before writing that code, tell the user in one plain sentence
which sites it will talk to and what it sends there, and get a yes. Example: *"This will contact
`api.open-meteo.com` and send it the city name you type - nothing else. OK?"*

**If that site needs credentials, there is one way to get them: a `password` preference.**
Lumanin runs no online services and does not broker sign-in - `OAuth.PKCEClient`, `OAuthService`,
`withAccessToken` and `getAccessToken` all throw, permanently, and nothing will change that.
Declare the token in the manifest, read it with `getPreferenceValues()`, and put *where to get
one* in the preference's `description`; the user pastes it in `lumanin plugins` and it stays on
their machine. If the service issues only OAuth credentials and has no personal access tokens at
all, say so plainly and stop - that plugin cannot be built here, and half of one is worse than
none.

**If a third-party npm package would genuinely help**: stop and ask first, in simple words -

- what the package is and what job it does in this plugin,
- how popular it is: weekly downloads on npm, how long it has existed, who depends on it,
- the honest part: installing a package means trusting its author's code with everything your
  user account can touch. Nobody here can promise it is safe; popularity and age are evidence,
  not proof.

Let the user decide. If they say no, build without it or narrow the feature. Never present this
policy as a sandbox - it is generation-time discipline, and an installed plugin runs with the
user's full permissions regardless.

## 4. Verify before declaring done

```sh
lumanin plugin-install <directory>      # builds it; build errors surface here
lumanin ext dev <directory>             # rebuild + reload on every save, for iterating
```

Then actually open the launcher (`lumanin toggle`, or its hotkey), run the command, and confirm
the first view renders **real data** and the main action works. A plugin is not done because it compiles, and it is not done
because its error state renders nicely - handing the user an error card that says "go configure
X first" is a failing verify, not a finished plugin. Nothing beyond the installed `lumanin` is
needed for this. Only if you happen to be inside a source checkout of the launcher is there an
optional harness (`scripts/verify-plugins.mjs`) that answers "did it render" mechanically - and
even then it cannot tell real rows from an error card, so look at what rendered.

**If the underlying tool needs setup** - not installed, an integration not enabled, nobody
signed in - doing that setup is part of this step, not homework for the user:

- run every setup command you can yourself, argv arrays as always; ask first, in one plain
  sentence, before anything that installs software or needs root,
- when a step can only happen in a GUI (a settings toggle in a desktop app) or needs a password
  or approval typed by a human, give exact click-by-click instructions, wait for the user to say
  it is done, and do the rest yourself,
- then re-run the underlying command, reopen the launcher, and re-verify - repeat until the
  view shows real data.

**Run the whole test pass yourself before handing the plugin over.** The user gets a finished
plugin, not a checklist. In the real window, with the plugin installed:

- open every command the manifest declares, not just the first one,
- pick every category in the dropdown and confirm each shows its own rows,
- type a query that matches, a query that matches nothing, and a query with one typo,
- dispatch every action that is safe to repeat (copy, open, show details); for a destructive or
  irreversible action, verify it appears in the Ctrl+K panel with the right title and shortcut
  and say plainly that you did not fire it,
- if the manifest declares preferences, set each one to a non-default value and confirm the
  plugin honours it,
- restart the session (close the window, reopen) once, so module-load crashes and stale caches
  show up.

Fix what fails and run the pass again from the top. Hand the plugin over only when a full pass
is clean, and say what you ran in one or two sentences.

Do not add `@types/*` or TypeScript tooling to the plugin - the build path compiles TypeScript
directly. It strips types rather than checking them, so a type error does not stop the build:
check what you emit against `reference.md`, and treat a runtime error card as the type check.

## 5. Offer publishing

When it works, offer to publish (do not push anything yourself unless asked). A published plugin
is a **public https git repository** holding the plugin directory; anyone installs it with

```sh
lumanin plugin-install <repository-url>
```

A repository can hold several plugins in subdirectories; the URL of the subdirectory installs
just that plugin. Lumanin records where every install came from.

Walk the user through these steps, in order, and run the ones they say yes to:

1. **Get a publishable directory.** If the plugin was written in an awkward place (a scratchpad,
   a temp dir), `lumanin plugin-export <name>` copies the installed plugin into the user's
   Downloads folder with a README (name, description, install command) and a `.gitignore`, and
   prints the git commands. Otherwise make sure the directory has both files; write the README
   yourself if it is missing.
2. **Check what is in it.** No `node_modules/`, no build output, no token or password pasted into
   the source, no personal paths in the manifest. A `password` preference is how a plugin takes a
   token; the token itself never ships.
3. **Create the repository and push.** With the GitHub CLI, from the plugin directory:

   ```sh
   git init && git add -A && git commit -m "<plugin name>"
   gh repo create <name> --public --source . --push
   ```

   Without `gh`, create an empty public repository in the browser and follow the push commands
   GitHub shows. The repository must be public and https; `plugin-install` refuses anything else.
4. **Add the `lumanin-plugins` topic.** `gh repo edit --add-topic lumanin-plugins`, or Topics in
   the repository's About box on GitHub. github.com/topics/lumanin-plugins is where people browse
   user-made plugins, so a plugin without the topic is findable only by URL.
5. **Prove the install path.** `lumanin plugin-install <repository-url>` from the fresh
   repository. It warns that this replaces the local install of the same name, which is the
   point; confirm the consent screen names the right repository, author and commands. This is
   the install every other user will run.
6. **Tell them how it reaches users.** Hand back the one line to share:
   `lumanin plugin-install <repository-url>`. Updates are a push to the repository; users
   reinstall to pick them up, nothing updates itself.
