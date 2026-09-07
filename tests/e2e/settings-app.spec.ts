import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { LumaninBridge } from '@shared/ipc'

/**
 * The settings app, end to end: a real second Electron application (launched
 * exactly the way `lumanin settings` launches it — as the `settings-shell/`
 * package) edits a real `config.toml` in an isolated XDG home, and the file is
 * the assertion. That is the app's whole contract: it writes the same file the
 * CLI and the daemon read, and nothing else.
 *
 * What this deliberately does not test: the compositor bind *apply* step. It
 * writes into desktop config files and its truth is per-desktop — that is the
 * VM round. The plan/consent surface (the banner) is asserted;
 * the write behind the Apply button is the same `applyPlan` the fix tests
 * already cover.
 */

const repoRoot = resolve(__dirname, '..', '..')

// One window, one temp home, in file order: a retry replays the file from the
// wizard, and a failure skips what would otherwise start in the wrong state.
test.describe.configure({ mode: 'serial' })

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
  // work around, which is itself part of what is being verified. The last test
  // does exactly that, so by now there may be nothing left to close.
  try {
    await app.close()
  } catch {
    // Already gone.
  }
})

const section = (title: string): ReturnType<Page['locator']> =>
  page.locator('.settings__section', { hasText: title })

/** A titled group on the current screen. */
const group = (title: string): ReturnType<Page['locator']> =>
  page.locator('.s-section', { has: page.locator('.s-section__title', { hasText: new RegExp(`^${title}$`) }) })

/** The compositor bind banner: the one line about this desktop's shortcut config. */
// Every wording the bind banner can take says one of these: the not-bindable
// note and the outcome report say "shortcut"; a blocked write quotes the
// desktop's problem, which names the config it could not edit (on CI's
// headless sway: no user config exists, so ours would shadow /etc/sway/config).
const bindBanner = (): ReturnType<Page['locator']> =>
  page.locator('.s-banner', { hasText: /shortcut|config/i })

test('a fresh home opens the first-run wizard; walking it through writes the marker', async () => {
  // No config.toml has ever existed here, so the wizard fronts the window:
  // three dots, the theme list and both key rows on the first step.
  await expect(page.locator('.wiz__title')).toContainText('Set up Lumanin')
  await expect(page.locator('.wiz__dot')).toHaveCount(3)
  await expect(page.locator('.s-row .s-hotkey')).toHaveCount(2)
  await expect(page.locator('.wiz__skip')).toHaveCount(1)

  // "Adaptive" writes nothing, which is the point: an untouched
  // wizard leaves an untouched config. The wizard is latched: this click makes
  // config.toml possible, and the wizard must not vanish under it.
  await page.locator('.wiz__choices .wiz__choice', { hasText: 'Adaptive' }).click()
  await expect(page.locator('.wiz__title')).toContainText('Set up Lumanin')

  // The apply step offers no skip: "Later" or "Next" leaves without writing.
  await page.locator('.wiz__buttons .s-button', { hasText: 'Next' }).click()
  await expect(page.locator('.wiz__title')).toContainText('Make it stick')
  await expect(page.locator('.wiz__buttons .s-button', { hasText: /^(Later|Next)$/ }).first()).toBeVisible()
  await expect(page.locator('.wiz__skip')).toHaveCount(0)
  await expect(page.locator('.wiz__buttons .s-button', { hasText: 'Skip' })).toHaveCount(0)
  await page.locator('.wiz__buttons .s-button', { hasText: /^(Later|Next)$/ }).first().click()
  await expect(page.locator('.wiz__title')).toContainText('All set')

  // Opening Settings is a real answer: the marker is state, not config, so
  // the wizard never returns unasked and config.toml still does not exist.
  await page.locator('.wiz__buttons .s-button', { hasText: 'Open Settings' }).click()
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

test('opens themed, on the Panel screen, with every section listed', async () => {
  await expect(page.locator('.settings__heading')).toHaveText('Panel')
  for (const title of ['Panel', 'Search', 'Keys', 'Plugins']) {
    await expect(section(title)).toBeVisible()
  }
})

test('the visual system holds: one typeface, grid rows, muted help, a focus ring, 24px targets', async () => {
  // The theme's mono token may be empty (the fontconfig default), in which
  // case the mono fallback stack is the one typeface everything shares.
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--lumanin-font-mono').trim()
  )
  const font = await page.locator('.settings').evaluate((el) => getComputedStyle(el).fontFamily)
  expect(font).toMatch(/monospace/i)
  if (token !== '') expect(font).toBe(token)
  for (const selector of ['.s-row__label', '.settings__section', '.settings__heading', '.s-button']) {
    const family = await page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily)
    expect(family, selector).toBe(font)
  }

  expect(await page.locator('.s-row').first().evaluate((el) => getComputedStyle(el).display)).toBe('grid')

  // Help text is muted, never faint: compare against probes coloured by token.
  const [muted, faint] = await page.evaluate(() => {
    const probe = (token: string): string => {
      const el = document.createElement('span')
      el.style.color = `var(${token})`
      document.body.append(el)
      const color = getComputedStyle(el).color
      el.remove()
      return color
    }
    return [probe('--lumanin-text-muted'), probe('--lumanin-text-faint')]
  })
  expect(muted).not.toBe(faint)
  const helpColors = await page.locator('.s-row__help').evaluateAll((els) => els.map((el) => getComputedStyle(el).color))
  expect(helpColors.length).toBeGreaterThan(0)
  for (const color of helpColors) expect(color).toBe(muted)

  // Keyboard focus draws the global ring: reach a pick button by Tab, not by click.
  const pick = page.locator('.s-pick').first()
  await pick.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement
    const style = getComputedStyle(el)
    return { className: el.className, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
  })
  expect(focused.className).toContain('s-pick')
  expect(focused.outlineStyle).toBe('solid')
  expect(focused.outlineWidth).not.toBe('0px')

  await section('Keys').click()
  expect(await page.locator('.s-hotkey').first().evaluate((el) => getComputedStyle(el).fontFamily)).toBe(font)
  const boxes = await page.locator('.s-remove, .s-iconbtn').evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
  )
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(24)
    expect(box.height).toBeGreaterThanOrEqual(24)
  }
  await section('Panel').click()
})

test('general: the update check answers with a sentence, whatever the checkout says', async () => {
  const row = page.locator('.s-row', { hasText: 'Launcher version' })
  await expect(row).toBeVisible()
  await row.locator('.s-button').click()
  // Up to date, behind by N commits, or unreachable - any of the three is a
  // truthful answer; a silent button is the failure.
  await expect(page.locator('.s-section', { hasText: 'Updates' }).locator('.s-banner')).toBeVisible({ timeout: 60_000 })
  await expect(row).toContainText(/checkout at|package|installed/i)
})

/** Where the log stood before the most recent write whose watcher push may still be pending. */
let lastWriteOffset = 0

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
  lastWriteOffset = logSize()
  await row.locator('.s-toggle').click()
  await expect.poll(config).not.toContain('hide_on_blur')
})

declare global {
  interface Window {
    readonly lumanin: LumaninBridge
    __pushedHideOnBlur?: boolean | null
  }
}

const settingsLog = (): string => join(root, 'state', 'lumanin', 'logs', 'lumanin-settings.jsonl')
const logSize = (): number => {
  try {
    return statSync(settingsLog()).size
  } catch {
    return 0
  }
}
/** The `reason` of every state push logged after `offset`, in order. */
const pushReasonsAfter = (offset: number): string[] => {
  let text: string
  try {
    text = readFileSync(settingsLog(), 'utf8').slice(offset)
  } catch {
    return []
  }
  const reasons: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const record = JSON.parse(line) as { msg?: unknown; reason?: unknown }
      if (record.msg === 'settings state push' && typeof record.reason === 'string') reasons.push(record.reason)
    } catch {
      // A line still being written.
    }
  }
  return reasons
}

test('a save pushes the new state itself, before the file watcher does', async () => {
  const row = page.locator('.s-row', { hasText: 'Hide when focus is lost' })
  await page.evaluate(() => {
    window.__pushedHideOnBlur = null
    // The latest push, not the first: the previous test's watcher push may
    // still land here, and "latest wins" in the app means nothing stale can
    // land after this test's own write.
    window.lumanin.on('settings.changed', (state) => {
      window.__pushedHideOnBlur = state.resolved.general.hideOnBlur.value
    })
  })

  // The previous test's last write is still being followed by its watcher
  // push (the debounce); let it be logged, or it would be the first reason seen.
  // The first 'watch' may be the earlier click's, so wait until the pushes go
  // quiet for longer than the watcher debounce before taking the offset.
  await expect.poll(() => pushReasonsAfter(lastWriteOffset)).toContain('watch')
  await expect
    .poll(async () => {
      const before = pushReasonsAfter(lastWriteOffset).length
      await new Promise((resolve) => setTimeout(resolve, 250))
      return pushReasonsAfter(lastWriteOffset).length === before
    })
    .toBe(true)
  const offset = logSize()
  await row.locator('.s-toggle').click()
  await expect.poll(config).toContain('hide_on_blur = false')
  await expect.poll(() => pushReasonsAfter(offset).length).toBeGreaterThan(0)
  // The first push after the click is the write's own; the watcher's, if it
  // ever comes, is behind it.
  expect(pushReasonsAfter(offset)[0]).toBe('write')
  await expect.poll(() => page.evaluate(() => window.__pushedHideOnBlur)).toBe(false)

  await row.locator('.s-toggle').click()
  await expect.poll(config).not.toContain('hide_on_blur')
})

test('two clicks back to back count as two: the second sees the first', async () => {
  const row = page.locator('.s-row', { hasText: 'Hide when focus is lost' })
  await expect(row.locator('.s-toggle')).toHaveAttribute('aria-checked', 'true')
  await row.locator('.s-toggle').click()
  await row.locator('.s-toggle').click()
  await expect.poll(config).not.toContain('hide_on_blur')
  await expect(row.locator('.s-toggle')).toHaveAttribute('aria-checked', 'true')
})

const option = (value: string): ReturnType<Page['locator']> =>
  page.locator(`[role="option"][data-value="${value}"]`)

test('an enum writes its value and the screen redraws from the file', async () => {
  const row = page.locator('.s-row', { hasText: 'Escape at the root' })
  await row.locator('.s-pick').click()
  await option('clear').click()
  await expect.poll(config).toContain('esc_at_root = "clear"')
  await expect(row.locator('.s-pick')).toContainText('Clear query')

  // A fixed default has no row of its own in the list: Reset is how it comes back.
  await row.getByRole('button', { name: 'Reset Escape at the root' }).click()
  await expect.poll(config).not.toContain('esc_at_root')
})

test('the pick list narrows as you type, Enter picks, Escape leaves it alone', async () => {
  const row = page.locator('.s-row', { hasText: 'Escape at the root' })
  await row.locator('.s-pick').click()
  const dialog = page.locator('.s-modal__box[role="dialog"]')
  await dialog.locator('input').type('cl')
  await expect(dialog.locator('[role="option"]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  await expect.poll(config).toContain('esc_at_root = "clear"')

  await row.locator('.s-pick').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  expect(config()).toContain('esc_at_root = "clear"')

  // A fixed default has no row of its own in the list: Reset is how it comes back.
  await row.getByRole('button', { name: 'Reset Escape at the root' }).click()
  await expect.poll(config).not.toContain('esc_at_root')
})

test('a number preset writes the number, and a typed value unchecks every preset', async () => {
  const row = page.locator('.s-row', { hasText: 'Panel width' })
  await row.getByRole('radio', { name: 'Wide', exact: true }).click()
  await expect.poll(config).toContain('width = 900')
  await expect(row.getByRole('radio', { name: 'Wide', exact: true })).toHaveAttribute('aria-checked', 'true')

  const input = row.locator('input[type="number"]')
  await input.fill('800')
  await input.press('Enter')
  await expect.poll(config).toContain('width = 800')
  await expect(row.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0)
})

test('a confirmed write says Saved at the row and the footer names the file and the time', async () => {
  const row = page.locator('.s-row', { hasText: 'Hide when focus is lost' })
  await row.locator('.s-toggle').click()
  await expect(row.locator('.s-row__saved')).toHaveText('Saved')
  await expect.poll(config).toContain('hide_on_blur = false')
  const footer = page.locator('.settings__footer')
  await expect(footer).toContainText(configFile())
  await expect(footer).toContainText('Saved at')

  await row.locator('.s-toggle').click()
  await expect.poll(config).not.toContain('hide_on_blur')
})

test('a value from the file offers Reset, which deletes the key', async () => {
  const row = page.locator('.s-row', { hasText: 'Panel width' })
  const reset = row.getByRole('button', { name: 'Reset Panel width' })
  await row.getByRole('radio', { name: 'Wide', exact: true }).click()
  await expect.poll(config).toContain('width = 900')
  await expect(reset).toBeVisible()
  await reset.click()
  await expect.poll(config).not.toContain('width')
  await expect(reset).toHaveCount(0)
})

test('the theme picker writes appearance.theme', async () => {
  await section('Panel').click()
  const row = page.locator('.s-row', { hasText: 'Theme' })
  await row.locator('.s-pick').click()
  await option('tokyo-day').click()
  await expect.poll(config).toContain('theme = "tokyo-day"')

  // The settings app follows its own edit: the theme service repaints this
  // very window from the changed file.
  await expect
    .poll(async () => await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lumanin-bg')))
    .toContain('#')

  await row.locator('.s-pick').click()
  await option('').click()
  await expect.poll(config).not.toContain('theme =')
})

test('file search: hotkey capture writes the chord, Backspace removes the key', async () => {
  await section('Keys').click()
  const row = group('File search').locator('.s-row', { hasText: 'Hotkey' })
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+Alt+F')
  await expect.poll(config).toContain('hotkey = "Ctrl+Alt+F"')

  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Backspace')
  await expect.poll(config).toContain('hotkey = ""')
  await expect(page.locator('.s-banner', { hasText: 'unreachable' })).toBeVisible()
})

test('file search: reordering categories writes the order', async () => {
  await section('Search').click()
  const list = group('File search').locator('.s-list')
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
  await section('Keys').click()
  // The row is found by its exact label, so a help line elsewhere that says
  // "action panel" cannot match instead.
  const row = page.locator('.s-row', {
    has: page.locator('.s-row__label', { hasText: /^Action panel$/ })
  })
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+J')
  await expect.poll(config).toContain('action_panel')
  await expect(row.locator('.s-chip', { hasText: 'Ctrl+J' })).toBeVisible()

  // Removing every added chord deletes the key — back to the shipped default.
  // One at a time, waiting for the file round trip between clicks: the chip
  // list redraws from the file, and clicking into a stale list writes stale
  // chords back.
  await row.locator('.s-chip', { hasText: 'Ctrl+J' }).locator('.s-remove').click()
  await expect(row.locator('.s-chip', { hasText: 'Ctrl+J' })).toHaveCount(0)
  await row.locator('.s-chip', { hasText: 'Ctrl+K' }).locator('.s-remove').click()
  await expect.poll(config).not.toContain('action_panel')
})

test('keys: the launcher hotkey writes general.hotkey and raises the bind banner', async () => {
  await section('Keys').click()
  const row = group('Launcher').locator('.s-row', { hasText: 'Hotkey' })
  await row.locator('.s-hotkey').click()
  await page.keyboard.press('Control+Alt+L')
  await expect.poll(config).toContain('hotkey = "Ctrl+Alt+L"')

  // config.toml and the desktop's shortcut config are never assumed to agree:
  // on a bindable desktop the change is applied automatically and the banner
  // reports what happened; anywhere else the "bind it yourself" wording shows.
  // Either way, something says so.
  await expect(bindBanner()).toBeVisible()
})

test('keys: the bind banner lives on the Keys screen, reports on Panel, and survives leaving', async () => {
  const notBindable = page.locator('.s-banner', { hasText: 'binds shortcuts through its own settings' })
  if ((await notBindable.count()) === 0) {
    // Bindable desktop: a global key says whether the desktop has it. The
    // file-search key was removed above, and no key gets no badge.
    await expect(group('Launcher').locator('.s-row', { hasText: 'Hotkey' }).locator('.s-badge')).toHaveCount(1)
    await expect(group('File search').locator('.s-row', { hasText: 'Hotkey' }).locator('.s-badge')).toHaveCount(0)
  }
  for (const title of ['Search', 'Plugins']) {
    await section(title).click()
    await expect(bindBanner()).toHaveCount(0)
  }
  // Panel writes the compositor's window rule, so it shows a write's outcome
  // there and nothing else: never the standing note about how keys are bound,
  // never the offer to apply a pre-existing difference.
  await section('Panel').click()
  await expect(bindBanner().filter({ hasText: 'binds shortcuts through its own settings' })).toHaveCount(0)
  await expect(bindBanner().getByRole('button', { name: 'Apply' })).toHaveCount(0)
  await section('Keys').click()
  await expect(bindBanner()).toBeVisible()
})

test('search: engines toggle and reorder as [search].engines', async () => {
  await section('Search').click()
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

test('search: Alt+Down moves the focused engine row and keeps focus on it', async () => {
  await section('Search').click()
  const engines = page.locator('.s-section', { hasText: 'Web search engines' })
  const rowOf = (id: string): ReturnType<Page['locator']> => engines.locator(`.s-list__row[data-id="${id}"]`)
  // Two enabled engines, in a known order: the test above switched the only
  // default one off.
  for (const id of ['google', 'ddg']) {
    const toggle = rowOf(id).locator('.s-toggle')
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
    await expect.poll(config).toContain(`"${id}"`)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  const firstRow = engines.locator('.s-list__row').first()
  await expect(firstRow).toHaveAttribute('data-id', 'google')
  const label = await firstRow.locator('.s-list__label').innerText()

  // The move buttons stay out of the way until the row is hovered.
  const down = firstRow.locator('[aria-label="Move down"]')
  await page.mouse.move(0, 0)
  await expect.poll(() => down.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
  await firstRow.hover()
  await expect.poll(() => down.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')

  await firstRow.locator('.s-toggle').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(engines.locator('.s-list__label').nth(1)).toHaveText(label)
  expect(
    await page.evaluate(() => document.activeElement?.closest('.s-list__row')?.getAttribute('data-id') ?? null)
  ).toBe('google')
  await expect
    .poll(() => {
      const match = /engines = \[([^\]]*)\]/.exec(config())
      return match?.[1]?.split(',')[1] ?? ''
    })
    .toContain('"google"')
})

test('file search: hidden-files preference toggles, persists, and redraws from the store', async () => {
  await section('Search').click()
  const row = page.locator('.s-row', { hasText: 'Hidden Files' }).first()
  await expect(row).toBeVisible()
  const toggle = row.locator('.s-toggle')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  // The switch shows the stored value, so it only flips once the save has
  // round-tripped and the screen re-fetched - which is the bug this guards.
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await section('Panel').click()
  await section('Search').click()
  await expect(page.locator('.s-row', { hasText: 'Hidden Files' }).first().locator('.s-toggle')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.locator('.s-row', { hasText: 'Hidden Files' }).first().locator('.s-toggle').click()
  await expect(page.locator('.s-row', { hasText: 'Hidden Files' }).first().locator('.s-toggle')).toHaveAttribute(
    'aria-checked',
    'false'
  )
})

test('plugins: the bundled file search is listed under Built in, with a toggle and no Remove', async () => {
  await section('Plugins').click()
  const heading = page.locator('.settings__content .s-section__title', { hasText: /^Built in$/ })
  await expect(heading).toBeVisible()
  const files = page.locator('.s-section', { has: page.locator('.s-plugin__title', { hasText: 'Files' }) })
  await expect(files).toBeVisible()
  // The card comes after the heading, not among the installed plugins.
  expect(await heading.evaluate((el, card) => Boolean(el.compareDocumentPosition(card) & 4), await files.elementHandle())).toBe(true)
  await expect(files.locator('.s-plugin__head .s-toggle')).toHaveAttribute('aria-checked', 'true')
  await files.locator('.s-plugin__title').click()
  await expect(files.locator('.s-plugin__body')).toBeVisible()
  await expect(files.locator('.s-button', { hasText: /^Remove$/ })).toHaveCount(0)
  await files.locator('.s-plugin__title').click()
})

test('plugins: with nothing installed the list says so, above the built-in ones', async () => {
  await section('Plugins').click()
  await expect(page.locator('.s-empty')).toHaveText('No plugins installed. The ones that ship with the app are listed below.')
})

test('a garbage install source is refused with a sentence, nothing spawned', async () => {
  await section('Plugins').click()
  const install = page.locator('.s-section', { hasText: 'Install a plugin' })
  await install.locator('input').fill('not a repository at all !!')
  await install.locator('input').blur()
  await install.locator('.s-button', { hasText: 'Fetch' }).click()
  await expect(install.locator('.s-error')).toBeVisible()
})

test('empty Pins, Aliases and Plugin hotkeys each say so in one sentence', async () => {
  await section('Search').click()
  await expect(page.locator('.s-section', { hasText: 'Pins' }).locator('.s-empty')).toHaveText('Nothing pinned.')
  await expect(page.locator('.s-section', { hasText: 'Aliases' }).locator('.s-empty')).toHaveText('No aliases.')
  await section('Keys').click()
  await expect(page.locator('.s-section', { hasText: 'Plugin hotkeys' }).locator('.s-empty')).toHaveText(
    'No plugin keys yet.'
  )
})

// A picker row by its exact label; `hasText` alone also matches the Plugins
// row's detail line.
const pickRow = (label: string): ReturnType<Page['locator']> =>
  page.locator('.s-pickrow', { has: page.locator('.s-pickrow__label', { hasText: new RegExp(`^${label}$`) }) })

test('pins: the same target twice is refused with a note and written once', async () => {
  await section('Search').click()
  const pins = page.locator('.s-section', { hasText: 'Pins' })
  const pinFirstCommand = async (): Promise<void> => {
    await pins.locator('.s-button', { hasText: 'Pin something' }).click()
    await pickRow('A command').click()
    await page.locator('.s-pickrow').first().click()
  }
  await pinFirstCommand()
  await expect.poll(config).toContain('command:')
  await pinFirstCommand()
  await expect(pins.locator('.s-error', { hasText: 'Already pinned' })).toBeVisible()
  const written = config()
  const key = /"(command:[^"]+)"/.exec(written)?.[1]
  expect(key).toBeDefined()
  expect(written.split(key ?? '').length - 1).toBe(1)
})

test('the target picker keeps focus inside and hands it back on close', async () => {
  const opener = page.locator('.s-section', { hasText: 'Pins' }).locator('.s-button', { hasText: 'Pin something' })
  await opener.click()
  await expect(page.locator('.s-modal__box[role="dialog"]')).toBeVisible()
  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('.s-modal__box') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true)
})

test('an alias cannot point at a web search: the picker does not offer one', async () => {
  const aliases = page.locator('.s-section', { hasText: 'Aliases' })
  await aliases.locator('input').fill('gg')
  await aliases.locator('.s-button', { hasText: 'Choose its target' }).click()
  await expect(pickRow('A command')).toBeVisible()
  await expect(pickRow('A web search')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.s-modal')).toHaveCount(0)
})

test('pins: keyboard only, filter at every level, Backspace goes up, Esc closes', async () => {
  await section('Search').click()
  const pins = page.locator('.s-section', { hasText: 'Pins' })
  const dialog = page.locator('.s-modal__box[role="dialog"]')
  const where = dialog.locator('nav[aria-label="Where you are"]')
  await pins.locator('.s-button', { hasText: 'Pin something' }).click()
  await expect(dialog.locator('input[role="combobox"]')).toBeFocused()
  await expect(where).toHaveCount(0)

  await page.keyboard.type('command')
  await expect(dialog.locator('.s-pickrow--active .s-pickrow__label')).toHaveText('A command')
  await page.keyboard.press('Enter')
  await expect(where).toBeVisible()
  await expect(where).toContainText('Commands')
  await page.keyboard.type('log')
  await expect(dialog.locator('[role="option"]')).toHaveCount(1)
  await expect(pickRow('Open Log File')).toBeVisible()

  // Three Backspaces clear the text; the fourth, on an empty filter, goes up.
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Backspace')
  await expect(pickRow('A command')).toBeVisible()
  await expect(where).toHaveCount(0)

  await page.keyboard.type('command')
  await page.keyboard.press('Enter')
  await page.keyboard.type('log')
  await page.keyboard.press('Enter')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  await expect.poll(config).toContain('command:builtin/open-log')

  // A mouse click on a row or a crumb must not take the keyboard away: typing
  // afterwards still narrows the list at the new level.
  const before = config()
  await pins.locator('.s-button', { hasText: 'Pin something' }).click()
  await expect(dialog).toBeVisible()
  await pickRow('A command').click()
  await expect(where).toContainText('Commands')
  await page.keyboard.type('log')
  await expect(dialog.locator('[role="option"]')).toHaveCount(1)
  await where.locator('button', { hasText: 'Targets' }).click()
  await expect(where).toHaveCount(0)
  await page.keyboard.type('command')
  await expect(dialog.locator('.s-pickrow--active .s-pickrow__label')).toHaveText('A command')
  await page.keyboard.press('Escape')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  expect(config()).toBe(before)
})

test('plugin hotkeys: the key is captured inside the picker, no second dialog', async () => {
  await section('Keys').click()
  const hotkeys = page.locator('.s-section', { hasText: 'Plugin hotkeys' })
  await hotkeys.locator('.s-button', { hasText: 'Bind a key' }).click()
  await pickRow('A command').click()
  await pickRow('Reload Theme').click()
  await expect(page.locator('.s-modal')).toHaveCount(1)
  await expect(page.locator('.s-modal .s-hotkey[aria-pressed="true"]')).toBeVisible()
  await page.keyboard.press('Control+Alt+Y')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  await expect.poll(config).toContain('target = "command:builtin/reload-theme"')
  expect(config()).toContain('bind = "Ctrl+Alt+Y"')

  // Removed again so the group is empty for whatever runs after this.
  await hotkeys.locator('.s-remove').first().click()
  await expect.poll(config).not.toContain('command:builtin/reload-theme')
})

test('a typed number commits on Enter', async () => {
  await section('Panel').click()
  const row = page.locator('.s-row', { hasText: 'Panel width' })
  const input = row.locator('input[type="number"]')
  await input.fill('850')
  await input.press('Enter')
  await expect.poll(config).toContain('width = 850')
})

test('Escape in a text field leaves the field and keeps the window', async () => {
  await section('Search').click()
  const input = page.locator('.s-section', { hasText: 'Aliases' }).locator('input')
  await input.click()
  await input.type('ff')
  await page.keyboard.press('Escape')
  expect(await input.evaluate((el) => el === document.activeElement)).toBe(false)
  await page.waitForTimeout(300)
  await expect(page.locator('.settings')).toBeVisible()
})

test('Ctrl+N switches sections from anywhere', async () => {
  await page.keyboard.press('Control+3')
  await expect(page.locator('.settings__heading')).toHaveText('Keys')
  await page.keyboard.press('Control+1')
  await expect(page.locator('.settings__heading')).toHaveText('Panel')
})

test('the filter hides what does not match, jumps to the section that does, and Esc clears it', async () => {
  const filter = page.locator('.settings__filter')
  await page.keyboard.press('Control+f')
  expect(await filter.evaluate((el) => el === document.activeElement)).toBe(true)

  await page.keyboard.type('focus is lost')
  const visibleRows = page.locator('.settings__content .s-row:visible')
  await expect(visibleRows).toHaveCount(1)
  await expect(visibleRows.locator('.s-row__label')).toHaveText('Hide when focus is lost')
  await expect(group('Appearance')).toBeHidden()

  await filter.fill('')
  await page.keyboard.type('action panel')
  await expect(page.locator('.settings__heading')).toHaveText('Keys')

  await page.keyboard.press('Escape')
  await expect(filter).toHaveValue('')
  expect(await filter.evaluate((el) => el === document.activeElement)).toBe(false)
  await expect(page.locator('.settings')).toBeVisible()
  await page.keyboard.press('Control+1')
  await expect(group('Appearance')).toBeVisible()
  expect(await page.locator('.settings__content .s-row:visible').count()).toBeGreaterThan(1)
})

test('Up and Down walk the rows, landing on the control so Space acts on it', async () => {
  await page.keyboard.press('Control+1')
  await page.locator('.settings__heading').click()
  await page.keyboard.press('ArrowDown')
  const toggle = page.locator('.s-row', { hasText: 'Hide when focus is lost' }).locator('.s-toggle')
  expect(await toggle.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(config).toContain('hide_on_blur = false')
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(config).not.toContain('hide_on_blur')

  // Down again lands in the second row, on its pick button; Enter opens the
  // list and Escape closes it, leaving the button focused.
  await page.keyboard.press('ArrowDown')
  const rows = page.locator('.settings__content .s-row:visible')
  expect(await rows.nth(1).evaluate((el) => el.contains(document.activeElement))).toBe(true)
  expect(await page.evaluate(() => document.activeElement?.className)).toBe('s-pick')
  await page.keyboard.press('Enter')
  await expect(page.locator('.s-modal__box[role="dialog"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.s-modal')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.className)).toBe('s-pick')

  // A row of presets lands on the checked pill, not the leftmost one, so a
  // Space there keeps the value instead of swapping it for the first preset.
  const width = page.locator('.s-row', { hasText: 'Panel width' })
  const wide = width.getByRole('radio', { name: 'Wide', exact: true })
  await wide.click()
  await expect.poll(config).toContain('width = 900')
  await page.locator('.settings__heading').click()
  for (let i = 0; i < 12 && !(await width.evaluate((el) => el.contains(document.activeElement))); i++) {
    await page.keyboard.press('ArrowDown')
  }
  expect(await wide.evaluate((el) => el === document.activeElement)).toBe(true)
  await page.keyboard.press('Space')
  await expect(wide).toHaveAttribute('aria-checked', 'true')
  await expect.poll(config).toContain('width = 900')
})

test('a slash typed in a text field is a character, not the filter key', async () => {
  await section('Search').click()
  const input = page.locator('.s-section', { hasText: 'Aliases' }).locator('input')
  await input.click()
  await input.type('a/b')
  await expect(input).toHaveValue('a/b')
  expect(await input.evaluate((el) => el === document.activeElement)).toBe(true)
  await input.fill('')
  await page.keyboard.press('Escape')
})

test('closing the window remembers its size and position, and quits the app', async () => {
  const closed = app.waitForEvent('close')
  await page.locator('.settings__close').click()
  await closed

  const saved = JSON.parse(readFileSync(join(root, 'state', 'lumanin', 'settings-window.json'), 'utf8')) as Record<
    string,
    unknown
  >
  for (const field of ['width', 'height', 'x', 'y']) {
    expect(Number.isInteger(saved[field]), field).toBe(true)
  }
})
