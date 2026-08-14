import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The root list: applications, commands, a calculation and a web search, all in
 * one place and ordered by `[search].fallback_order`.
 *
 * Driven through a real daemon because the interesting part is the wiring —
 * config reaching the composer, the composer reaching the renderer, and the
 * renderer labelling each row with what Enter will actually do. The ordering
 * rules themselves are unit-tested where they can be exercised without a window.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

const CONFIG = `
[search]
engines = ["google", "archwiki"]
pins = ["command:builtin/quit"]

[[search.rules]]
match = "keyring"
first = ["command:builtin/open-config", "command:builtin/open-log"]

[aliases]
ff = "firefox.desktop"
rl = "builtin/reload-applications"

# The panel's own keys, rebound — the point of the test below is that the
# renderer answers to these and not to the ones it shipped with.
[keys]
next = "Ctrl+N"
previous = "Ctrl+P"
`

let app: ElectronApplication
let page: Page

interface Row {
  readonly title: string
  readonly subtitle: string | null
  readonly action: string | null
}

async function rows(query: string): Promise<Row[]> {
  await page.locator('.search__input').fill(query)
  // Settle: composition is synchronous in main but the round trip is not.
  await page.waitForTimeout(150)
  return page.locator('.result').evaluateAll((elements) =>
    elements.map((element) => ({
      title: element.querySelector('.result__title')?.textContent ?? '',
      subtitle: element.querySelector('.result__subtitle')?.textContent ?? null,
      action: element.querySelector('.result__action')?.textContent ?? null
    }))
  )
}

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-root-e2e-'))
  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(join(root, 'config', 'lumanin', 'config.toml'), CONFIG)

  app = await electron.launch({
    args: [repoRoot, '--show'],
    env: {
      ...process.env,
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

test('answers a calculation, and says it will copy it', async () => {
  const [first] = await rows('2+2*3')

  expect(first?.title).toBe('8')
  // The expression under the answer: without it the row is a bare number in a
  // list, and you cannot tell what it answered.
  expect(first?.subtitle).toBe('2+2*3')
  expect(first?.action).toBe('Copy')
})

test('converts units', async () => {
  expect((await rows('10 km to miles'))[0]?.title).toContain('6.21371')
  expect((await rows('90 degC in degF'))[0]?.title).toBe('194 degF')
})

test('stays silent for queries that merely look like arithmetic', async () => {
  // The failure this guards against is a calculator row appearing while you type
  // an application name, which is worse than having no calculator.
  for (const query of ['7-zip', 'gimp 2.10', 'python3']) {
    const calculations = (await rows(query)).filter((row) => row.action === 'Copy')
    expect(calculations, query).toHaveLength(0)
  }
})

test('finds a root command by a word that is not in its name', async () => {
  // "rescan" is nowhere in "Reload Applications" — it is what someone types when
  // an app they just installed has not appeared, which is the only reason to
  // reach for this command.
  const list = await rows('rescan')
  const reload = list.find((row) => row.title === 'Reload Applications')
  expect(reload).toBeDefined()

  // It may sit under an application: `fallback_order` puts apps first, and this
  // asserts the label rather than the position.
  const index = list.indexOf(reload as Row)
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown')
  const selected = await page.locator('.result[aria-selected="true"]').evaluate((element) => ({
    title: element.querySelector('.result__title')?.textContent ?? '',
    action: element.querySelector('.result__action')?.textContent ?? null
  }))

  expect(selected.title).toBe('Reload Applications')
  expect(selected.action).toBe('Run')
})

test('offers every enabled search, under every query', async () => {
  const nothing = await rows('zzzzqqqqxxxx')
  expect(nothing.map((row) => row.title)).toEqual([
    'Search Google for “zzzzqqqqxxxx”',
    'Search Arch Wiki for “zzzzqqqqxxxx”'
  ])

  // …and still there under a query that *did* match, at the bottom. This is the
  // whole point: reaching the web search must never mean retyping the query.
  const matched = await rows('rescan')
  expect(matched.some((row) => row.title === 'Reload Applications')).toBe(true)
  expect(matched.at(-1)?.title).toBe('Search Arch Wiki for “rescan”')
})

test('a pinned command outranks whatever else matched', async () => {
  const list = await rows('qui')
  expect(list[0]?.title).toBe('Quit Lumanin')
})

test('a rule injects its rows for its own query only', async () => {
  // Neither command has "keyring" anywhere in it — the rule is an override, and
  // the ordering inside it is the one the rule gave.
  const list = await rows('keyring')
  expect(list.slice(0, 2).map((row) => row.title)).toEqual([
    'Open Configuration File',
    'Open Log File'
  ])

  const elsewhere = await rows('rescan')
  expect(elsewhere[0]?.title).not.toBe('Open Configuration File')
})

test('a keyword search wins outright, even when other things matched', async () => {
  const [first] = await rows('g reload applications')

  expect(first?.title).toBe('Search Google for “reload applications”')
  expect(first?.action).toBe('Search')
})

test('an alias resolves to its target and goes first', async () => {
  const [first] = await rows('rl')

  expect(first?.title).toBe('Reload Applications')
  expect(first?.action).toBe('Run')
})

test('the action label is only on the selected row', async () => {
  const list = await rows('e')
  expect(list.length).toBeGreaterThan(1)

  expect(list.filter((row) => row.action !== null)).toHaveLength(1)
  expect(list[0]?.action).not.toBeNull()
})

test('running a command reports success and closes the panel', async () => {
  await rows('rescan')
  await page.keyboard.press('Enter')

  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
})

/**
 * `[keys]` — the panel answers to the user's keys, not to ours.
 *
 * Rebinding these is the one kind of key change that involves nobody else: the
 * window has focus, the renderer reads the event, and there is no compositor to
 * agree with. So this is the whole contract, end to end: a chord in
 * `config.toml`, read by main, pushed across the bridge, matched in the
 * renderer.
 */
test('moves the selection with the keys the config named', async () => {
  const list = await rows('e')
  expect(list.length).toBeGreaterThan(1)
  await expect(page.locator('.result').first()).toHaveAttribute('aria-selected', 'true')

  // The rebound key moves…
  await page.locator('.search__input').press('Control+n')
  await expect(page.locator('.result').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.locator('.search__input').press('Control+p')
  await expect(page.locator('.result').first()).toHaveAttribute('aria-selected', 'true')

  // …and the default it replaced does not. A rebind that merely *added* a key
  // would pass a test that only checked the new one.
  await page.locator('.search__input').press('ArrowDown')
  await expect(page.locator('.result').first()).toHaveAttribute('aria-selected', 'true')
})
