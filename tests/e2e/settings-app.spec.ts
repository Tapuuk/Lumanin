import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The settings app, end to end: a real second Electron application (launched
 * exactly the way `lumanin settings` launches it — as the `settings-shell/`
 * package) edits a real `config.toml` in an isolated XDG home, and the file is
 * the assertion. That is the app's whole contract: it writes the same file the
 * CLI and the daemon read, and nothing else.
 *
 * What this deliberately does not test: the compositor bind *apply* step. It
 * writes into desktop config files and its truth is per-desktop — that is the
 * VM round in TESTING.md. The plan/consent surface (the banner) is asserted;
 * the write behind the Apply button is the same `applyPlan` the fix tests
 * already cover.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

let root: string
let app: ElectronApplication
let page: Page

const configFile = (): string => join(root, 'config', 'lumanin', 'config.toml')
const config = (): string => {
  try {
    return readFileSync(configFile(), 'utf8')
  } catch {
    return ''
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lumanin-settings-e2e-'))
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 })

  app = await electron.launch({
    args: [join(repoRoot, 'settings-shell')],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_RUNTIME_DIR: join(root, 'run'),
      LUMANIN_LOG: 'debug',
      ...absoluteWaylandDisplay()
    }
  })

  page = await app.firstWindow()
  await page.waitForSelector('.settings__sidebar')
})

test.afterAll(async () => {
  // A normal application: closing its window quits it — no daemon lifecycle to
  // work around, which is itself part of what is being verified.
  await app.close()
})

const section = (title: string): ReturnType<Page['locator']> =>
  page.locator('.settings__section', { hasText: title })

test('a fresh home opens the first-run wizard; dismissing it writes the marker', async () => {
  // No config.toml has ever existed here, so the wizard fronts the window.
  await expect(page.locator('.wiz__title')).toContainText('Hey there')

  // Walk into the theme step and pick the default. "Follow the desktop"
  // writes nothing, which is the point — an untouched wizard leaves an
  // untouched config. The wizard is latched: this click makes config.toml
  // possible, and the wizard must not vanish under it.
  await page.locator('.wiz__next').click()
  await expect(page.locator('.wiz__title')).toContainText('Pick a look')
  await page.locator('.wiz__choice', { hasText: 'Follow the desktop' }).click()
  await expect(page.locator('.wiz__title')).toContainText('Pick a look')

  // Skipping is a real answer: the marker is state, not config, so the
  // wizard never returns unasked and config.toml still does not exist.
  await page.locator('.wiz__buttons .s-button', { hasText: 'Back' }).click()
  await page.locator('.wiz__skip').click()
  await expect(page.locator('.wiz')).toHaveCount(0)
  await expect
    .poll(() => {
      try {
        readFileSync(join(root, 'state', 'lumanin', 'first-run-done'), 'utf8')
        return true
      } catch {
        return false
      }
    })
    .toBe(true)
  expect(config()).toBe('')
})

test('opens themed, on the General screen, with every section listed', async () => {
  await expect(page.locator('.settings__heading')).toHaveText('General')
  for (const title of [
    'General',
    'Appearance',
    'Global Search',
    'File Search',
    'Action Keys',
    'Plugin Hotkeys',
    'Plugins'
  ]) {
    await expect(section(title)).toBeVisible()
  }
})

test('a toggled setting lands in config.toml, and toggling back to the default deletes the key', async () => {
  const row = page.locator('.s-row', { hasText: 'Hide when focus is lost' })
  await row.locator('.s-toggle').click()

  // Instant apply: the file changes without any Save button.
  await expect.poll(config).toContain('hide_on_blur = false')
  // …and the control redraws from the *file*, not from what was clicked — the
  // second click below must see the round-tripped state, or it would write
  // `false` right back.
  await expect(row.locator('.s-toggle')).toHaveAttribute('aria-checked', 'false')

  // Back to the default: the key is *deleted*, not written as `true`, so the
  // default stays free to improve underneath this config.
  await row.locator('.s-toggle').click()
  await expect.poll(config).not.toContain('hide_on_blur')
})

test('an enum writes its value and the screen redraws from the file', async () => {
  const row = page.locator('.s-row', { hasText: 'Escape at the root' })
  await row.locator('select').selectOption('clear')
  await expect.poll(config).toContain('esc_at_root = "clear"')
  await expect(row.locator('select')).toHaveValue('clear')

  await row.locator('select').selectOption('')
  await expect.poll(config).not.toContain('esc_at_root')
})

test('a number preset writes the number', async () => {
  const row = page.locator('.s-row', { hasText: 'Panel width' })
  await row.locator('select').selectOption('900')
  await expect.poll(config).toContain('width = 900')
})

test('the theme picker writes appearance.theme', async () => {
  await section('Appearance').click()
  const row = page.locator('.s-row', { hasText: 'Theme' })
  await row.locator('select').selectOption('tokyo-day')
  await expect.poll(config).toContain('theme = "tokyo-day"')

  // The settings app follows its own edit: the theme service repaints this
  // very window from the changed file.
  await expect
    .poll(async () => await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lumanin-bg')))
    .toContain('#')

  await row.locator('select').selectOption('')
  await expect.poll(config).not.toContain('theme =')
})

test('file search: hotkey capture writes the chord, Backspace removes the key', async () => {
  await section('File Search').click()
  const row = page.locator('.s-row', { hasText: 'Hotkey' }).first()
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+Alt+F')
  await expect.poll(config).toContain('hotkey = "Ctrl+Alt+F"')

  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Backspace')
  await expect.poll(config).toContain('hotkey = ""')
  await expect(page.locator('.s-banner', { hasText: 'unreachable' })).toBeVisible()
})

test('file search: reordering categories writes the order', async () => {
  const list = page.locator('.s-list').last()
  const first = await list.locator('.s-list__label').first().innerText()
  await list.locator('.s-list__row').first().locator('[aria-label="Move down"]').click()
  await expect.poll(config).toContain('order = [')
  const written = config()
  // The previously-first category is now second in the written list.
  const match = /order = \[([^\]]*)\]/.exec(written)
  expect(match?.[1]?.split(',')[0]).not.toContain(firstCategoryId(first))
})

function firstCategoryId(title: string): string {
  return title.toLowerCase().split(' ')[0] ?? title
}

test('action keys: a captured chord is added, and removing it restores the default', async () => {
  await section('Action Keys').click()
  // `hasText` also matches help prose (Back's help says "action panel"), so
  // the row is found by its exact label.
  const row = page.locator('.s-row', {
    has: page.locator('.s-row__label', { hasText: /^Action Panel$/ })
  })
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+J')
  await expect.poll(config).toContain('action_panel')
  await expect(row.locator('.s-chip', { hasText: 'Ctrl+J' })).toBeVisible()

  // Removing every added chord deletes the key — back to the shipped default.
  // One at a time, waiting for the file round trip between clicks: the chip
  // list redraws from the file, and clicking into a stale list writes stale
  // chords back.
  await row.locator('.s-chip', { hasText: 'Ctrl+J' }).locator('.s-chip__remove').click()
  await expect(row.locator('.s-chip', { hasText: 'Ctrl+J' })).toHaveCount(0)
  await row.locator('.s-chip', { hasText: 'Ctrl+K' }).locator('.s-chip__remove').click()
  await expect.poll(config).not.toContain('action_panel')
})

test('global search: the hotkey writes general.hotkey and raises the bind banner', async () => {
  await section('Global Search').click()
  const row = page.locator('.s-row', { hasText: 'Hotkey' }).first()
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+Alt+L')
  await expect.poll(config).toContain('hotkey = "Ctrl+Alt+L"')

  // config.toml and the desktop's shortcut config are never assumed to agree:
  // on a bindable desktop the change is applied automatically and the banner
  // reports what happened; anywhere else the "bind it yourself" wording shows.
  // Either way, something says so.
  await expect(page.locator('.s-banner').first()).toBeVisible()
})

test('global search: engines toggle and reorder as [search].engines', async () => {
  const engines = page.locator('.s-section', { hasText: 'Web search engines' })
  const firstRow = engines.locator('.s-list__row').first()
  const firstEngine = await firstRow.locator('.s-list__label').innerText()

  await firstRow.locator('.s-toggle').click()
  await expect.poll(config).toContain('engines = [')
  await expect
    .poll(() => {
      const match = /engines = \[([^\]]*)\]/.exec(config())
      return match?.[1] ?? ''
    })
    .not.toContain(`"${firstEngine.toLowerCase()}"`)
})

test('plugins: the bundled file-search plugin is listed, disable-not-remove enforced', async () => {
  await section('Plugins').click()
  // The bundled plugin's manifest title is "Files"; "Search Files" is its
  // command's title.
  const card = page.locator('.s-section', {
    has: page.locator('.s-plugin__title', { hasText: 'Files' })
  })
  await expect(card).toBeVisible()

  await card.locator('.s-toggle').first().click()
  await expect.poll(config).toMatch(/disabled = \[ ?"files" ?\]/)
  // Wait for the file round trip to redraw the switch before toggling back.
  await expect(card.locator('.s-toggle').first()).toHaveAttribute('aria-checked', 'false')

  await card.locator('.s-plugin__title').click()
  // Bundled: no Remove button, and the sentence explains why.
  await expect(card.locator('.s-button--danger')).toHaveCount(0)
  await expect(card.locator('.s-plugin__body')).toContainText('turned off but not removed')

  await card.locator('.s-toggle').first().click()
  await expect.poll(config).not.toContain('disabled')
})

test('a garbage install source is refused with a sentence, nothing spawned', async () => {
  await section('Plugins').click()
  const install = page.locator('.s-section', { hasText: 'Install a plugin' })
  await install.locator('input').fill('not a repository at all !!')
  await install.locator('input').blur()
  await install.locator('.s-button', { hasText: 'Fetch' }).click()
  await expect(install.locator('.s-error')).toBeVisible()
})
