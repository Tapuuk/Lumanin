import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The real-window flows: Playwright (Electron) for the few flows that need a
 * real window. Everything else is a Vitest unit — this file exists only for the
 * things that are not true unless a browser actually renders them: that typing
 * produces results, that the panel is a bar until it has something to show and
 * the window's height afterwards, and that Enter launches.
 *
 * The app runs against a temporary XDG tree so the test cannot read or write the
 * developer's real config, index their real applications, or record launches
 * into their real frecency database.
 */

const repoRoot = resolve(__dirname, '..', '..')

/** Absolute compositor socket, so overriding `XDG_RUNTIME_DIR` cannot hide it. */
function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

/**
 * The window's geometry **according to the compositor**.
 *
 * Not a nicety. Electron's `getBounds()`, `window.outerHeight` and
 * `visualViewport` all report the size Chromium asked for, whether or not the
 * compositor granted it, and Playwright's own screenshots agree with them
 * because they capture the web contents rather than the screen. A whole class of
 * bug — the panel not resizing at all — is invisible to every one of those and
 * obvious to this.
 *
 * Returns `null` where there is no Hyprland to ask, which is most CI.
 */
function compositorGeometry(): { at: [number, number]; size: [number, number] } | null {
  try {
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' })) as {
      class: string
      at: [number, number]
      size: [number, number]
    }[]
    const panel = clients.find((client) => client.class === 'lumanin')
    return panel === undefined ? null : { at: panel.at, size: panel.size }
  } catch {
    return null
  }
}

/** The panel's own box — what the user sees, as distinct from the window. */
async function panelBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.panel').boundingBox()
  if (box === null) throw new Error('the panel is not rendered')
  return box
}

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-e2e-'))
  // An empty config.toml marks the profile as a set-up machine, or the daemon
  // opens the first-run wizard alongside the panel and its window steals the
  // focus from every assertion that follows.
  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(join(root, 'config', 'lumanin', 'config.toml'), '')

  // Fixture applications, so the assertions about "many results" and "a whole
  // family" hold on any machine — a CI runner has a handful of .desktop entries
  // where a desktop has hundreds. Names are chosen to stay out of the way of
  // the queries other tests pin exactly ("firefox" must keep its two rows):
  // twelve E-names answer the single-letter query, four LibreTests are the
  // family. `Exec=true` because nothing here is ever launched.
  const applications = join(root, 'data', 'applications')
  mkdirSync(applications, { recursive: true })
  const fixtureApps = [
    'Editor Alpha', 'Editor Bravo', 'Editor Carol', 'Editor Delta',
    'Editor Echo', 'Editor Foxtrot', 'Editor Golf', 'Editor Hotel',
    'Editor India', 'Editor Juliet', 'Editor Kilo', 'Editor Lima',
    'LibreTest Writer', 'LibreTest Calc', 'LibreTest Impress', 'LibreTest Draw'
  ]
  for (const name of fixtureApps) {
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    writeFileSync(
      join(applications, `${slug}.desktop`),
      `[Desktop Entry]\nType=Application\nName=${name}\nExec=true\n`
    )
  }

  app = await electron.launch({
    args: [repoRoot, '--show'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      // A private runtime dir keeps this daemon's control socket away from the
      // developer's running one — otherwise the test either steals it or refuses
      // to start.
      XDG_RUNTIME_DIR: join(root, 'run'),
      // …but the *compositor's* socket also lives in the real runtime dir, so
      // redirecting it blindly means Electron cannot connect to Wayland at all
      // and dies before Playwright can attach. An absolute WAYLAND_DISPLAY is
      // resolved directly, bypassing XDG_RUNTIME_DIR, so both can be true.
      ...absoluteWaylandDisplay(),
      LUMANIN_HIDE_ON_BLUR: 'false'
    }
  })

  page = await app.firstWindow()
  await page.waitForSelector('.search__input')
})

test.afterAll(async () => {
  // `app.close()` alone hangs, and correctly so: the daemon intercepts `close`
  // and turns it into `hide`, and `window-all-closed` deliberately does not
  // quit. That is the whole point of the process model — the window is
  // disposable, the daemon is not — so the test has to ask it to exit the way
  // the CLI's `quit` verb does.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.exit(0)
  })
  await app.close().catch(() => undefined)
})

test('opens as a bare search bar, not a box', async () => {
  // The shape the whole layout is built around: nothing below the input until
  // there is something to show. The *window* is the full 480 either way — it is
  // the panel that is a bar — so this has to measure the panel.
  await expect(page.locator('.results')).toHaveCount(0)
  expect((await panelBox(page)).height).toBeLessThan(70)
})

test('the window is the configured size, and the compositor agrees', async () => {
  const geometry = compositorGeometry()
  test.skip(geometry === null, 'no Hyprland to ask')
  expect(geometry?.size).toEqual([760, 480])
})

test('the search field has focus without a click', async () => {
  // A launcher you have to click before typing has already failed.
  const focused = await page.evaluate(() => document.activeElement?.className)
  expect(focused).toContain('search__input')
})

test('typing produces ranked results and grows the panel', async () => {
  const before = (await panelBox(page)).height

  await page.locator('.search__input').fill('fire')
  await expect(page.locator('.result').first()).toBeVisible()

  expect((await panelBox(page)).height).toBeGreaterThan(before)

  // Ranked, not merely matched: the app whose name starts with the query is first.
  const first = await page.locator('.result__title').first().innerText()
  expect(first.toLowerCase()).toContain('fire')
})

test('the search bar does not move as results appear', async () => {
  // The reason the window is a fixed box rather than one resized to fit: a
  // compositor that anchors a client-initiated resize by the window's *centre*
  // — Hyprland does — slides the search field upward on every keystroke, out
  // from under the text being typed.
  await page.locator('.search__input').fill('')
  await expect(page.locator('.result')).toHaveCount(0)
  const empty = await page.locator('.search').boundingBox()

  await page.locator('.search__input').fill('fire')
  await expect(page.locator('.result').first()).toBeVisible()
  const oneResult = await page.locator('.search').boundingBox()

  await page.locator('.search__input').fill('e')
  await expect(page.locator('.result').nth(4)).toBeVisible()
  const manyResults = await page.locator('.search').boundingBox()

  expect(oneResult?.y).toBe(empty?.y)
  expect(manyResults?.y).toBe(empty?.y)

  // And the window under it never moved either, which is the half that only the
  // compositor can confirm.
  const geometry = compositorGeometry()
  if (geometry !== null) expect(geometry.size).toEqual([760, 480])
})

test('shows an icon for applications that have one', async () => {
  await page.locator('.search__input').fill('fire')
  await expect(page.locator('.result').first()).toBeVisible()

  // Served through `lumanin-icon:`, never as a filesystem path — the renderer is
  // sandboxed and must not learn where anything lives.
  const src = await page.locator('.result').first().locator('img').getAttribute('src')
  expect(src).toMatch(/^lumanin-icon:/)

  // And it actually decoded: a broken image still has a src.
  const width = await page
    .locator('.result')
    .first()
    .locator('img')
    .evaluate((img) => (img as HTMLImageElement).naturalWidth)
  expect(width).toBeGreaterThan(0)
})

test('does not bury a clear winner under near-misses', async () => {
  // "fire" is a real subsequence of `LibreOffice Impress` too
  // (l-i-b-**f**-f-**i**-ce imp-**r**-**e**ss), and of six other things. Ranking
  // alone put the right answer first with eight irrelevant rows under it; the
  // relative cutoff is what makes the list say what it means.
  await page.locator('.search__input').fill('fire')
  await expect(page.locator('.result').first()).toBeVisible()

  expect(await page.locator('.result').count()).toBeLessThanOrEqual(3)
})

test('keeps a whole family when the family genuinely matches', async () => {
  // The other half of the same rule: a relative cutoff must not amputate a set
  // of results that are all comparably good.
  await page.locator('.search__input').fill('libre')
  await expect(page.locator('.result').first()).toBeVisible()

  expect(await page.locator('.result').count()).toBeGreaterThan(3)
})

test('grows and shrinks with the result count, and gives it back when empty', async () => {
  // The panel hugs its content: more results make it taller, fewer make it
  // shorter, an empty query leaves the bare bar. "Fill the window once there is
  // anything to show" was tried and reverted on the user's call —
  // on a translucent theme the filled region reads as a washed-out slab over
  // the desktop. See the note on `.panel` in base.css.
  await page.locator('.search__input').fill('e')
  await expect(page.locator('.result').first()).toBeVisible()
  const many = (await panelBox(page)).height

  // Two rows: the application, and the web search that is always offered.
  await page.locator('.search__input').fill('firefox')
  await expect(page.locator('.result')).toHaveCount(2)
  expect((await panelBox(page)).height).toBeLessThan(many)

  // …and the bare bar is the empty state, which is the whole look.
  await page.locator('.search__input').fill('')
  await expect(page.locator('.result')).toHaveCount(0)
  expect((await panelBox(page)).height).toBeLessThan(70)
})

test('a query matching nothing falls back to web searches, and nothing else', async () => {
  // It used to leave the panel a bare bar. Now an unmatched query is exactly
  // the case the web fallback exists for — "nothing here, try the web" — so the
  // assertion is that *only* those rows appear, not that none do.
  await page.locator('.search__input').fill('zzzzqqqqxxxx')
  await expect(page.locator('.result').first()).toBeVisible()

  const titles = await page.locator('.result__title').allInnerTexts()
  expect(titles.every((title) => title.startsWith('Search '))).toBe(true)
})

test('arrow keys move the selection and never leave the list', async () => {
  await page.locator('.search__input').fill('e')
  await expect(page.locator('.result').first()).toBeVisible()

  const selected = (): Promise<string> =>
    page.locator('.result[aria-selected="true"] .result__title').innerText()

  const first = await selected()
  await page.keyboard.press('ArrowDown')
  expect(await selected()).not.toBe(first)

  // Up from the top stays at the top rather than falling off.
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  expect(await selected()).toBe(first)
})

test('the panel stops growing at the configured ceiling and scrolls', async () => {
  await page.locator('.search__input').fill('e')
  await expect(page.locator('.result').first()).toBeVisible()

  expect((await panelBox(page)).height).toBeLessThanOrEqual(480)

  const scrolls = await page.locator('.results').evaluate((el) => el.scrollHeight > el.clientHeight)
  expect(scrolls).toBe(true)
})

test('Escape clears a query before it closes anything', async () => {
  // `esc_at_root` governs the root only — the first Escape backs out of the
  // query, it does not throw it away along with the window.
  await page.locator('.search__input').fill('fire')
  await page.keyboard.press('Escape')

  await expect(page.locator('.search__input')).toHaveValue('')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(
    true
  )
})

test('is already empty by the time it is hidden, so the next open cannot flash', async () => {
  // The defect this exists for, reported from a real session: dismissing with a
  // click left the results in the DOM, and the next open mapped the window at
  // last time's full height for a frame before collapsing to a bare search bar.
  // Clearing on show is one frame too late — by then the window is on screen.
  await page.locator('.search__input').fill('fire')
  await expect.poll(() => page.locator('.result').count()).toBeGreaterThan(0)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide()
  })

  // Asserted while hidden: the reset has to have happened here, not on the way
  // back up.
  await expect.poll(() => page.locator('.result').count()).toBe(0)
  await expect(page.locator('.search__input')).toHaveValue('')

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
})

test('clicking the transparent area below the panel dismisses it', async () => {
  // That area is still our window, so it never blurs and `hide_on_blur` cannot
  // fire — without an explicit handler it would be the one place on screen where
  // clicking away does nothing.
  await page.locator('.search__input').fill('')
  const panel = await panelBox(page)
  await page.mouse.click(panel.width / 2, panel.height + 120)

  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false)

  // Left visible for whatever runs next.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
})
