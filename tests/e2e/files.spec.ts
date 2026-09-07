import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Search Files, driven through the real window against a real filesystem.
 *
 * The point of this one is that nothing is faked. The plugin is the source in
 * `plugins/files/`, built with the product's own externals; the files it finds
 * are real files this test writes; and the tool it finds them with is whichever
 * of `fd`/`plocate`/`find` the machine actually has. A unit test with a mocked
 * `useExec` would pass with the argv wrong, the tool missing, and the ranking
 * inverted — which is the whole feature.
 *
 * `HOME` is pointed at a throwaway tree, because "search your home directory" is
 * what the plugin does and there is no version of this test that is honest and
 * also looks at the developer's own files.
 *
 * It is opened the way it is opened in real life: by asking the daemon to open
 * it, over the control socket, which is exactly what the key bound to
 * `[file_search].hotkey` runs. There is no other way in — the command is not at
 * the root — so a test that reached it another way would be testing a door that
 * does not exist.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

let app: ElectronApplication
let page: Page
let socketPath: string

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-files-e2e-'))
  const home = join(root, 'home')
  // An empty config.toml marks the profile as a set-up machine. Without it the
  // daemon opens the first-run wizard alongside the panel — a second Electron
  // app that steals the focus, outlives `app.exit()`, and turns every teardown
  // into a 30-second timeout.
  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(join(root, 'config', 'lumanin', 'config.toml'), '')
  socketPath = join(root, 'run', 'lumanin.sock')

  // A tree with something to rank. `report-draft.md` and `quarterly-report.md`
  // both match "report"; only the first *starts* with it, and the ordering rule
  // says it goes first. `deep/` exists so depth breaks the remaining tie.
  mkdirSync(join(home, 'Documents', 'deep', 'deeper'), { recursive: true })
  mkdirSync(join(home, 'Downloads'), { recursive: true })
  writeFileSync(join(home, 'Documents', 'quarterly-report.md'), '#\n')
  writeFileSync(join(home, 'Documents', 'report-draft.md'), '#\n')
  writeFileSync(join(home, 'Documents', 'deep', 'deeper', 'report-buried.md'), '#\n')
  writeFileSync(join(home, 'Downloads', 'unrelated.zip'), 'x')
  // One per category that the ordering test needs: a folder, a picture and a
  // text file all matching the same query.
  mkdirSync(join(home, 'Pictures', 'kinds-folder'), { recursive: true })
  writeFileSync(join(home, 'Pictures', 'kinds.png'), 'x')
  writeFileSync(join(home, 'Pictures', 'kinds.md'), '#\n')

  // Nothing is installed into this profile. Search Files is a *bundled* plugin,
  // so it has to be there because the application shipped it — which is the
  // other half of what this spec proves. `out/plugins/files` is written by
  // `scripts/build-plugins.mjs`, the last step of `npm run build`.

  app = await electron.launch({
    args: [repoRoot, '--show'],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_RUNTIME_DIR: join(root, 'run'),
      ...absoluteWaylandDisplay(),
      LUMANIN_HIDE_ON_BLUR: 'false'
    }
  })

  page = await app.firstWindow()
  await page.waitForSelector('.search__input')
})

test.afterAll(async () => {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.exit(0)
  })
  await app.close().catch(() => undefined)
})

const input = (): ReturnType<Page['locator']> => page.locator('.search__input')

/**
 * Back to the root, whatever screen we are on.
 *
 * By the placeholder, not by the action bar: a plugin view showing an empty
 * state has no actions and therefore no action bar, so "no action bar" reads as
 * "already at the root" while the panel is still the plugin's. That mistake sent
 * the next test's query into the plugin's own search field.
 */
async function toRoot(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await input().getAttribute('placeholder')) === 'Search...') break
    await input().press('Escape')
    await page.waitForTimeout(150)
  }
  await expect(input()).toHaveAttribute('placeholder', 'Search...')
  await input().fill('')
}

/**
 * What the file-search key runs: one `open` verb over the control socket.
 *
 * The same request `lumanin open extension:files/search` sends, and the same one
 * the compositor bind for `[file_search].hotkey` sends. Written out here rather
 * than shelling out to the CLI so the failure is a socket error rather than a
 * build-path problem.
 */
function openVerb(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => {
      socket.destroy()
      reject(new Error('the daemon did not answer'))
    })
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, verb: { kind: 'open', target } })}\n`)
    })
    socket.on('data', (chunk: string) => {
      socket.destroy()
      const reply = JSON.parse(chunk.trim()) as { ok: boolean; error?: string }
      if (reply.ok) resolve()
      else reject(new Error(reply.error ?? 'the daemon refused'))
    })
  })
}

/**
 * Long enough that the next `open` is a second press rather than a key repeat.
 *
 * The key both opens and closes now, so the daemon collapses requests that
 * arrive within `TOGGLE_COALESCE_MS` of each other — a held key produces one
 * every ~30 ms and each one would otherwise flip the panel. A test driving the
 * socket directly can outrun a human by an order of magnitude, so it waits out
 * the window that a finger cannot cross anyway.
 */
const PAST_THE_BURST_MS = 250

async function openSearchFiles(): Promise<void> {
  await toRoot()
  await page.waitForTimeout(PAST_THE_BURST_MS)
  await openVerb('extension:files/search')
  // The plugin's own placeholder is how we know the panel is its view now.
  await expect(input()).toHaveAttribute('placeholder', 'Search Files', { timeout: 15_000 })
}

/**
 * Not at the root, at all.
 *
 * The decision this feature exists to implement, in its strongest form: file
 * search is a second search surface with a key of its own, so the root can
 * neither run it nor be made to search the filesystem. Its command is not a row,
 * and typing a filename finds nothing.
 */
test('is not reachable from the root list', async () => {
  await toRoot()
  await input().fill('search files')
  await page.waitForTimeout(400)
  expect(await page.locator('.result__title').allTextContents()).not.toContain('Search Files')

  await input().fill('report-draft')
  await page.waitForTimeout(400)
  // A web search is still offered — that row is offered under every query — but
  // nothing on the filesystem is.
  const titles = await page.locator('.result__title').allTextContents()
  expect(titles.some((title) => title.endsWith('.md'))).toBe(false)
})

test('opens on its own key, as a bare search bar', async () => {
  await openSearchFiles()
  // Opening the view must not start walking a home directory: an empty pattern
  // matches every file on the machine. And it must not say anything about it
  // either — nothing typed draws nothing, so the panel is exactly the bar.
  await expect(page.locator('.result')).toHaveCount(0)
  await expect(page.locator('.ext-empty')).toHaveCount(0)

  const panel = await page.locator('.panel').boundingBox()
  const bar = await page.locator('.search').boundingBox()
  expect(panel?.height).toBeLessThanOrEqual((bar?.height ?? 0) + 4)
})

/**
 * Escape at the bottom closes the window rather than dropping into the launcher.
 *
 * There is no root list behind this session: the panel was opened to be this
 * view. Backing out into a launcher nobody asked for would be the panel turning
 * into a different application under the user.
 */
test('closes the window on Escape instead of falling back to the root', async () => {
  await openSearchFiles()
  await input().press('Escape')
  // Asked of the main process, not of `document.visibilityState`: a hidden
  // BrowserWindow does not reliably mark its document hidden, and a test that
  // believed it would pass on a window still sitting on screen.
  await expect
    .poll(
      async () =>
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        ),
      { timeout: 5000 }
    )
    .toBe(false)

  // And the next open is this view again, not the launcher's last frame.
  await page.waitForTimeout(PAST_THE_BURST_MS)
  await openVerb('extension:files/search')
  await expect(input()).toHaveAttribute('placeholder', 'Search Files', { timeout: 15_000 })
  await input().press('Escape')
})

/**
 * The key that opened it also puts it away.
 *
 * The global toggle has always done this; every other key ran `open`, which only
 * ever opened — so the one gesture everybody already knows did nothing on the
 * second press. Tested from *inside a pushed view* on purpose: the key closes
 * the session, not the top of its navigation stack, so it works the same however
 * deep the user walked.
 */
test('closes on a second press of its own key, from any depth', async () => {
  await openSearchFiles()
  await input().fill('Documents')
  await expect(page.locator('.result__title').first()).toHaveText('Documents', { timeout: 15_000 })
  await input().press('Enter')
  await expect(input()).toHaveAttribute('placeholder', 'Filter Documents', { timeout: 10_000 })

  // Past the burst window, so this reads as a second press rather than a key
  // repeat of the first one (`shared/toggle.ts`).
  await page.waitForTimeout(PAST_THE_BURST_MS)
  await openVerb('extension:files/search')
  await expect
    .poll(
      async () =>
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        ),
      { timeout: 5000 }
    )
    .toBe(false)

  // And the press after that opens it again, at the top rather than back inside
  // the folder — hiding ended the session.
  await page.waitForTimeout(PAST_THE_BURST_MS)
  await openVerb('extension:files/search')
  await expect(input()).toHaveAttribute('placeholder', 'Search Files', { timeout: 15_000 })
  await input().press('Escape')
})

test('finds real files and ranks a prefix match first', async () => {
  await openSearchFiles()

  await input().fill('report')
  // A filesystem search is not instant; the rows arrive when the tool exits.
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 15_000 })

  const titles = await page.locator('.result__title').allTextContents()
  expect(titles).toContain('report-draft.md')
  expect(titles).toContain('quarterly-report.md')
  expect(titles).toContain('report-buried.md')

  // Closest to home first, and only then the name: both of the ones in
  // ~/Documents come before the one four levels down, and between those two the
  // prefix match leads.
  expect(titles[0]).toBe('report-draft.md')
  expect(titles.indexOf('quarterly-report.md')).toBeLessThan(titles.indexOf('report-buried.md'))
})

/**
 * The categories, in the configured order, as sections.
 *
 * Three things called `kinds` in one folder: a directory, a picture and a text
 * file. The default order says Folders, Images, …, Text — so the sections come
 * back in that order whatever order `fd` walked them in, which is the ordering
 * being tested rather than the filesystem's.
 */
test('groups hits into file-type sections, in the configured order', async () => {
  await openSearchFiles()
  await input().fill('kinds')
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 15_000 })

  expect(await page.locator('.results__section').allTextContents()).toEqual([
    'Folders',
    'Images',
    'Text'
  ])
  expect(await page.locator('.result__title').allTextContents()).toEqual([
    'kinds-folder',
    'kinds.png',
    'kinds.md'
  ])
})

test('shows where each hit lives, written the way a person writes it', async () => {
  await openSearchFiles()
  await input().fill('report-draft')
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.result__subtitle').first()).toHaveText('~/Documents')
})

test('offers open, reveal, a terminal and copy on a hit', async () => {
  await openSearchFiles()
  await input().fill('report-draft')
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 15_000 })

  await input().press('Control+k')
  await expect(page.locator('.overlay__panel')).toBeVisible()
  expect(await page.locator('.overlay__label').allTextContents()).toEqual([
    'Open',
    'Open Containing Folder',
    'Open in Terminal',
    'Copy Path',
    'Copy Name'
  ])
  await page.locator('.overlay__panel').press('Escape')
})

/**
 * Open means *launch the file*.
 *
 * On a file the first section holds one action, so both keys run it: a `.blend`
 * opens in Blender whether you press Enter or Space. Revealing it is a real
 * thing to want, but it is one section down with a shortcut of its own —
 * because `secondary` used to be "the second action anywhere in the panel", and
 * pressing open on a file got you a file manager.
 */
test('gives a file the same action on both keys, and it is Open', async () => {
  await openSearchFiles()
  await input().fill('report-draft')
  await expect(page.locator('.result__title').first()).toHaveText('report-draft.md', {
    timeout: 15_000
  })

  await expect(page.locator('.actionbar__label')).toHaveText('Open')
  // The bar still hints the actions that declared their own shortcut, but none
  // of them has claimed the secondary key — so Space and Ctrl+↵ fall through to
  // the primary, which is Open.
  const hints = await page.locator('.actionbar__item .actionbar__key').allTextContents()
  expect(hints).not.toContain('Space')
  expect(hints).not.toContain('Ctrl+↵')
})

test('shows nothing, and says nothing, when there are no matches', async () => {
  await openSearchFiles()
  await input().fill('zzzznosuchfile')
  await page.waitForTimeout(1200)
  // Not an empty state: the launcher's own root list answers a query that
  // matches nothing by staying a search bar, and this is the same search bar.
  await expect(page.locator('.result')).toHaveCount(0)
  await expect(page.locator('.ext-empty')).toHaveCount(0)
})

test('multiple words match a name in order', async () => {
  await openSearchFiles()
  // "quarterly report" is not a substring of anything; it is two halves of a
  // name, which is how people search.
  await input().fill('quarterly report')
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.result__title').first()).toHaveText('quarterly-report.md')
})

test('searches the whole home directory, with nothing to scope it to', async () => {
  await openSearchFiles()
  // The dropdown is gone: one search bar, one question. Scope was a setting that
  // had to be answered before the question you came to ask, and the answer was ~
  // every time.
  await expect(page.locator('.dropdown__button')).toHaveCount(0)

  // Both of these are in the home tree but in different folders, and one search
  // finds each of them.
  await input().fill('unrelated')
  await expect(page.locator('.result__title').first()).toHaveText('unrelated.zip', {
    timeout: 15_000
  })

  await input().fill('quarterly-report')
  await expect(page.locator('.result__title').first()).toHaveText('quarterly-report.md', {
    timeout: 15_000
  })
})

/**
 * Enter goes *in*.
 *
 * The behaviour this feature exists for: a folder is not a thing to open, it is
 * a thing to look inside. Each level is a real pushed view rather than a `cwd`
 * in state, which is what makes the launcher's own Back key walk back up one
 * directory at a time instead of dropping out of the plugin entirely.
 */
test('enters a folder on Enter, and walks back out with Escape', async () => {
  await openSearchFiles()
  await input().fill('Documents')

  const first = page.locator('.result__title').first()
  await expect(first).toHaveText('Documents', { timeout: 15_000 })
  await input().press('Enter')

  // Inside: the listing, filtered by nobody — the search box was cleared on the
  // way in, so the text that found the folder does not narrow its contents.
  await expect(input()).toHaveAttribute('placeholder', 'Filter Documents', { timeout: 10_000 })
  await expect(input()).toHaveValue('')
  expect(await page.locator('.result__title').allTextContents()).toEqual([
    // Directories first, then names — the order every file manager lists in.
    'deep',
    'quarterly-report.md',
    'report-draft.md'
  ])

  // The box is empty in here, so the bar advertises the bare key — this is the
  // "a key with no modifier is also typing" rule, seen from the outside: Space
  // is offered exactly while it would work.
  await expect(page.locator('.actionbar__item .actionbar__key').first()).toHaveText('Space')

  // Deeper, then back out one level at a time.
  await input().press('Enter')
  await expect(input()).toHaveAttribute('placeholder', 'Filter deep', { timeout: 10_000 })
  await input().press('Escape')
  await expect(input()).toHaveAttribute('placeholder', 'Filter Documents', { timeout: 10_000 })
  await input().press('Escape')
  await expect(input()).toHaveAttribute('placeholder', /^Search /, { timeout: 10_000 })
})

test('filters a listing with the launcher’s own rules', async () => {
  await openSearchFiles()
  await input().fill('Documents')
  await expect(page.locator('.result__title').first()).toHaveText('Documents', { timeout: 15_000 })
  await input().press('Enter')
  await expect(input()).toHaveAttribute('placeholder', 'Filter Documents', { timeout: 10_000 })

  // A listing is a fixed list, so the box narrows it with the launcher's rules
  // — including the one forgiven typo, which no plugin has to implement.
  await input().fill('quartrly')
  await expect(page.locator('.result__title')).toHaveCount(1)
  await expect(page.locator('.result__title').first()).toHaveText('quarterly-report.md')
})

/**
 * The keys, in the order the row declared its actions.
 *
 * Enter runs the first action and `secondary` the second, so a folder's actions
 * are ordered "go in, then open" and a file's "open, then reveal". The bar is
 * what tells the user that, and it has to name the chord that would work *now*:
 * Space while the box is empty, Ctrl+↵ once it is not.
 */
test('offers Enter Folder then Open in File Manager on a folder', async () => {
  await openSearchFiles()
  await input().fill('Documents')
  await expect(page.locator('.result__title').first()).toHaveText('Documents', { timeout: 15_000 })

  await expect(page.locator('.actionbar__label')).toHaveText('Enter Folder')
  // Typing is what found the row, so the advertised secondary chord is the one
  // that survives typing.
  await expect(page.locator('.actionbar__item-title').first()).toHaveText('Open in File Manager')
  await expect(page.locator('.actionbar__item .actionbar__key').first()).toHaveText('Ctrl+↵')

  await input().press('Control+k')
  const rows = await page.locator('.overlay__row').allTextContents()
  expect(rows.slice(0, 2)).toEqual(['Enter Folder', 'Open in File Manager'])
  await page.keyboard.press('Escape')
})

/**
 * The icons are the desktop's, not ours.
 *
 * `naturalWidth` rather than the URL alone: a `lumanin-icon://theme/…` src that
 * main answered with a 404 renders as a broken image and looks, in a screenshot,
 * exactly like one that worked. Non-zero means the icon theme lookup found a
 * real file and the protocol handler served it.
 */
test('draws folder and file icons from the system icon theme', async () => {
  await openSearchFiles()
  await input().fill('report')
  await expect(page.locator('.result__title').first()).toHaveText('report-draft.md', {
    timeout: 15_000
  })

  const icons = page.locator('.result img')
  await expect(icons.first()).toHaveAttribute('src', /lumanin-icon:\/\/theme\//)

  const loaded = await icons.first().evaluate((element) => {
    const image = element as HTMLImageElement
    return image.complete && image.naturalWidth > 0
  })
  expect(loaded).toBe(true)
})
