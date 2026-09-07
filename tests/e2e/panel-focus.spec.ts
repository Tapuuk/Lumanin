import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Regression: closing the Ctrl+K action panel must give the keyboard back.
 *
 * Reported from a real plugin (a 1Password item browser): open the panel on any
 * row, close it, and the whole launcher reads as frozen. The renderer was fine —
 * the overlay had taken focus from the search input on mount and nobody returned
 * it on unmount, so `document.activeElement` was `<body>`. The search input is
 * the only element in the window with a keydown handler, which means *every* key
 * (typing, arrows, Enter, Esc, Ctrl+K) landed nowhere. A keyboard-first launcher
 * with zero working keys is indistinguishable from a hung one.
 *
 * The existing extension e2e could not see it because Playwright's
 * `locator.press()` re-focuses its target first — the assertions here use
 * `page.keyboard` on purpose, which sends keys to whatever really has focus.
 *
 * The fixture mirrors the reporting plugin's distinctive shapes so they stay
 * covered too: conditional `{cond && <Action…/>}` children inside `ActionPanel`
 * (two of them gated on the same condition), and a "legend" `List.Item` with an
 * empty title, tag accessories, and no `actions` prop at all.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

const EXTENSION_SOURCE = `
import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "lumanin";

const ITEMS: { id: string; title: string; url?: string }[] = [
  { id: "a", title: "Alpha Login", url: "https://a.example" },
  { id: "b", title: "Beta Note" },
];

// The reporting plugin's copySecret shape: an Animated toast that is mutated
// into Success once the (slow) work finishes.
async function fakeCopy(what: string) {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Getting " + what });
  await new Promise((resolve) => setTimeout(resolve, 600));
  toast.style = Toast.Style.Success;
  toast.title = "Copied " + what;
}

export default function Command() {
  return (
    <List searchBarPlaceholder="Search vault">
      {ITEMS.map((item) => (
        <List.Item
          key={item.id}
          title={item.title}
          icon={Icon.Key}
          accessories={[{ tag: "Private" }]}
          actions={
            <ActionPanel>
              <Action title="Copy Password" icon={Icon.Clipboard} onAction={() => fakeCopy("password")} />
              {item.url && (
                <Action.CopyToClipboard title="Copy URL" content={item.url} shortcut={{ modifiers: ["cmd"], key: "u" }} />
              )}
              <Action title="Copy Email" icon={Icon.Envelope} shortcut={{ modifiers: ["cmd"], key: "e" }} onAction={() => {}} />
              <Action title="Copy Username" icon={Icon.Person} shortcut={{ modifiers: ["shift"], key: "u" }} onAction={() => fakeCopy("username")} />
              {item.url && (
                <Action.OpenInBrowser url={item.url} shortcut={{ modifiers: ["cmd"], key: "b" }} />
              )}
            </ActionPanel>
          }
        />
      ))}
      <List.Section title="Shortcuts">
        <List.Item
          title=""
          icon="http://127.0.0.1:9/favicon.ico"
          accessories={[
            { tag: { value: "Enter password", color: Color.SecondaryText } },
            { tag: { value: "CtrlU url", color: Color.SecondaryText } },
            { tag: { value: "CtrlE email", color: Color.SecondaryText } },
          ]}
        />
      </List.Section>
    </List>
  );
}
`

const MANIFEST = {
  name: 'vaultfix',
  title: 'Vaultfix',
  description: 'Fixture: conditional actions and an actionless legend row',
  author: 'lumanin',
  license: 'MIT',
  categories: ['Other'],
  commands: [
    { name: 'search-items', title: 'Search Vault Items', description: 'fixture', mode: 'view' }
  ]
}

let app: ElectronApplication
let page: Page

/** From the root, launch the fixture command and wait for its rows. */
async function enterExtension(): Promise<void> {
  await page.locator('.search__input').fill('search vault')
  await page.locator('.result').first().click()
  await expect(page.locator('.result__title').first()).toHaveText('Alpha Login', { timeout: 10_000 })
}

/** Wherever we are, get back to the launcher's root list. */
async function returnToRoot(): Promise<void> {
  for (let step = 0; step < 4; step++) {
    const placeholder = await page.locator('.search__input').getAttribute('placeholder')
    if (placeholder === 'Search...') {
      await page.locator('.search__input').fill('')
      return
    }
    // `locator.press` re-focuses the input first, so this works even from a
    // state the bug under test would have wedged.
    await page.locator('.search__input').press('Escape')
  }
  throw new Error('could not return to the root list')
}

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-panel-focus-e2e-'))
  const source = join(root, 'source')
  mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(source, 'src', 'search-items.tsx'), EXTENSION_SOURCE)

  const installed = join(root, 'data', 'lumanin', 'extensions', 'vaultfix')
  mkdirSync(join(installed, 'commands'), { recursive: true })
  await build({
    entryPoints: [join(source, 'src', 'search-items.tsx')],
    outfile: join(installed, 'commands', 'search-items.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    jsx: 'automatic',
    logLevel: 'silent',
    external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'lumanin']
  })
  cpSync(join(source, 'package.json'), join(installed, 'package.json'))

  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(join(root, 'config', 'lumanin', 'config.toml'), '[general]\nhide_on_blur = false\n')

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

test('closing the panel with Esc returns the keyboard to the search input', async () => {
  await enterExtension()

  // Opened via the locator, which re-focuses the input first: launching the
  // command with a mouse click can leave focus in flux for a moment, and *how*
  // the panel opens is not what this spec guards. What happens after it closes
  // is — those presses use `page.keyboard` and no locator, deliberately.
  await page.locator('.search__input').press('Control+k')
  await expect(page.locator('.overlay__panel')).toBeVisible()
  // The conditional children rendered as actions, not as holes or stray rows.
  expect(await page.locator('.overlay__label').allTextContents()).toEqual([
    'Copy Password',
    'Copy URL',
    'Copy Email',
    'Copy Username',
    'Open in Browser'
  ])

  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay__panel')).toHaveCount(0)

  // The heart of the regression: no locator press, no re-focus — the next keys
  // must land in the search input because focus was *given back*.
  await expect(page.evaluate(() => document.activeElement?.className)).resolves.toContain(
    'search__input'
  )
  await page.keyboard.type('beta')
  await expect(page.locator('.search__input')).toHaveValue('beta')
  await expect(page.locator('.result__title')).toHaveText(['Beta Note'])
})

test('closing the panel by running an action also returns the keyboard', async () => {
  await returnToRoot()
  await enterExtension()

  await page.locator('.search__input').press('Control+k')
  await expect(page.locator('.overlay__panel')).toBeVisible()
  await page.keyboard.press('Enter') // runs "Copy Password", closes the overlay
  await expect(page.locator('.overlay__panel')).toHaveCount(0)

  await page.keyboard.type('alpha')
  await expect(page.locator('.search__input')).toHaveValue('alpha')
})

test('a row with no actions at all cannot wedge the panel either', async () => {
  await returnToRoot()
  await enterExtension()

  // The legend row: empty title, tag accessories, no `actions` prop.
  await page.locator('.search__input').press('ArrowDown')
  await page.locator('.search__input').press('ArrowDown')
  await expect(page.locator('.result[aria-selected="true"] .result__accessory').first()).toHaveText(
    'Enter password'
  )

  await page.locator('.search__input').press('Control+k')
  await page.keyboard.press('Escape')
  await expect(page.locator('.overlay__panel')).toHaveCount(0)

  await page.keyboard.type('alpha')
  await expect(page.locator('.search__input')).toHaveValue('alpha')
  await expect(page.locator('.result__title')).toHaveText(['Alpha Login'])
})

test('the footer hint bar lists the shortcut actions for the selected row', async () => {
  await returnToRoot()
  await enterExtension()

  // `⏎ <primary>` plus every non-primary action that declared a shortcut,
  // compactly keyed. "Copy Password" has no shortcut beyond Enter; the rest do.
  await expect(page.locator('.actionbar__label')).toHaveText('Copy Password')
  expect(await page.locator('.actionbar__item .actionbar__key').allTextContents()).toEqual([
    'Ctrl+U',
    'Ctrl+E',
    '⇧U',
    'Ctrl+B'
  ])
  expect(await page.locator('.actionbar__item-title').allTextContents()).toEqual([
    'Copy URL',
    'Copy Email',
    'Copy Username',
    'Open in Browser'
  ])

  // The legend row has no actions at all: the hints follow the selection away.
  await page.locator('.search__input').press('ArrowDown')
  await page.locator('.search__input').press('ArrowDown')
  await expect(page.locator('.actionbar')).toHaveCount(0)

  // Its icon is a remote URL nothing answers (the `getFavicon` 404 case): the
  // <img> must degrade to the globe glyph, never Chromium's broken-image box.
  const legendIcon = page.locator('.result[aria-selected="true"] .result__icon')
  await expect(legendIcon.locator('.result__glyph')).toHaveText('⊕')
  await expect(legendIcon.locator('img')).toHaveCount(0)
})

test('running the primary action with plain Enter (no overlay) leaves the keyboard alive', async () => {
  await returnToRoot()
  await enterExtension()

  await page.locator('.search__input').press('Enter')
  await expect(page.locator('.toast')).toHaveClass(/toast--animated/)
  await expect(page.locator('.toast')).toHaveClass(/toast--success/, { timeout: 5000 })
  await expect(page.locator('.toast__title')).toHaveText('Copied password')

  // No overlay was ever open, so nothing may have moved focus — raw keys next.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.result[aria-selected="true"] .result__title')).toHaveText('Beta Note')
  await page.keyboard.press('Escape')
  await expect(page.locator('.search__input')).toHaveAttribute('placeholder', 'Search...')
})

test('a shift-only shortcut fires from the search field, suppresses the character, and keeps the keyboard', async () => {
  await returnToRoot()
  await enterExtension()

  await page.locator('.search__input').press('Shift+U')
  // The chord ran the action rather than typing a "U" into the filter.
  await expect(page.locator('.search__input')).toHaveValue('')
  await expect(page.locator('.toast__title')).toHaveText('Copied username', { timeout: 5000 })

  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.result[aria-selected="true"] .result__title')).toHaveText('Beta Note')
  await page.keyboard.press('Escape')
  await expect(page.locator('.search__input')).toHaveAttribute('placeholder', 'Search...')
})

test('an Animated→Success toast transition never moves focus', async () => {
  await returnToRoot()
  await enterExtension()

  await page.locator('.search__input').press('Enter')

  // During the animated phase…
  await expect(page.locator('.toast')).toHaveClass(/toast--animated/)
  await expect(page.evaluate(() => document.activeElement?.className)).resolves.toContain(
    'search__input'
  )

  // …and after the extension mutates it to success.
  await expect(page.locator('.toast')).toHaveClass(/toast--success/, { timeout: 5000 })
  await expect(page.evaluate(() => document.activeElement?.className)).resolves.toContain(
    'search__input'
  )

  await page.keyboard.type('beta')
  await expect(page.locator('.result__title')).toHaveText(['Beta Note'])
  await page.keyboard.press('Escape')
  await expect(page.locator('.search__input')).toHaveAttribute('placeholder', 'Search...')
})
