import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The theme chain, end to end: a real daemon resolves a real Omarchy theme
 * directory, pushes tokens over IPC, and the renderer repaints — with no reload
 * and no restart.
 *
 * The Omarchy tree is synthetic, inside the temporary XDG state home this spec
 * already creates (Omarchy 4's layout; the daemon also probes the older
 * `$XDG_CONFIG_HOME/omarchy/current`). That is not a compromise: the daemon
 * reads `$XDG_STATE_HOME/omarchy/current/theme` and cannot tell the difference, and
 * driving `omarchy theme set` against the developer's real session would restart
 * their waybar, terminal and notification daemon to prove something a directory
 * swap proves just as well.
 *
 * The swap below reproduces `omarchy-theme-set` exactly — assemble in
 * `next-theme`, `rm -rf` the old, `mv`, then write `theme.name` — because that
 * sequence is what breaks the obvious implementation. See
 * `src/platform/appearance/omarchy.ts`.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

function colours(background: string, foreground: string, accent: string): string {
  return `
accent = "${accent}"
foreground = "${foreground}"
background = "${background}"
color0 = "#45475a"
color1 = "#f38ba8"
color2 = "#a6e3a1"
color3 = "#f9e2af"
color4 = "${accent}"
color5 = "#f5c2e7"
color6 = "#94e2d5"
color7 = "#bac2de"
color8 = "#585b70"
color9 = "#f38ba8"
color10 = "#a6e3a1"
color11 = "#f9e2af"
color12 = "${accent}"
color13 = "#f5c2e7"
color14 = "#94e2d5"
color15 = "#a6adc8"
`
}

let root: string
let app: ElectronApplication
let page: Page

/** What `omarchy-theme-set` does, step for step. */
function themeSet(name: string, body: string, extra: Record<string, string> = {}): void {
  const current = join(root, 'state', 'omarchy', 'current')
  const next = join(current, 'next-theme')
  mkdirSync(next, { recursive: true })
  writeFileSync(join(next, 'colors.toml'), body)
  for (const [file, contents] of Object.entries(extra)) writeFileSync(join(next, file), contents)

  rmSync(join(current, 'theme'), { recursive: true, force: true })
  renameSync(next, join(current, 'theme'))
  writeFileSync(join(current, 'theme.name'), `${name}\n`)
}

/** The value the renderer is actually painting with, read off `:root`. */
function cssVar(name: string): Promise<string> {
  return page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name
  )
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lumanin-theme-e2e-'))
  // An empty config.toml marks the profile as a set-up machine, or the daemon
  // opens the first-run wizard alongside the panel and its window steals the
  // focus from every assertion that follows.
  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(join(root, 'config', 'lumanin', 'config.toml'), '')
  mkdirSync(join(root, 'state', 'omarchy', 'current'), { recursive: true })
  themeSet('mocha', colours('#1a1b1e', '#cdd6f4', '#89b4fa'))

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

test("adopts the desktop's theme rather than the built-in default", async () => {
  // `#1a1b26` would be Tokyo Night — the built-in. Seeing it here would mean the
  // chain never got past its last link.
  await expect.poll(() => cssVar('--lumanin-bg')).toBe('#1a1b1e')
  expect(await cssVar('--lumanin-accent')).toBe('#89b4fa')
})

test('follows a theme switch live, with no reload', async () => {
  themeSet('gruvbox', colours('#282828', '#ebdbb2', '#458588'))

  await expect.poll(() => cssVar('--lumanin-bg'), { timeout: 10_000 }).toBe('#282828')
  expect(await cssVar('--lumanin-text')).toBe('#ebdbb2')
})

test('follows a second switch, after the theme directory has been replaced', async () => {
  // The one that matters. `omarchy-theme-set` deletes and recreates the theme
  // directory, so a watch placed on it works exactly once — this test fails
  // against that implementation and passes against a watch on the parent.
  themeSet('latte', colours('#eff1f5', '#4c4f69', '#1e66f5'))

  await expect.poll(() => cssVar('--lumanin-bg'), { timeout: 10_000 }).toBe('#eff1f5')
})

test('takes the variant from light.mode, not from the palette alone', async () => {
  themeSet('white', colours('#ffffff', '#000000', '#0057b7'), { 'light.mode': '' })

  await expect.poll(() => cssVar('--lumanin-bg'), { timeout: 10_000 }).toBe('#ffffff')
  // Surfaces have to step *down* from a white background; stepping up would make
  // them invisible.
  const surface = await cssVar('--lumanin-bg-surface')
  expect(surface).not.toBe('#ffffff')
})

test("a theme's own lumanin.toml wins over what we would derive", async () => {
  themeSet('authored', colours('#282828', '#ebdbb2', '#458588'), {
    'lumanin.toml': '[meta]\nname = "Authored"\n[colors]\nbg = "#010203"\ntext = "#fefefe"\n'
  })

  await expect.poll(() => cssVar('--lumanin-bg'), { timeout: 10_000 }).toBe('#010203')
})

test('never leaves a token undefined, whatever the theme said', async () => {
  // The failure this guards against is invisible text, so it is worth asserting
  // against the live document rather than only against the resolver.
  const missing = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return [
      'bg',
      'bg-surface',
      'bg-selected',
      'bg-hover',
      'border',
      'border-focus',
      'text',
      'text-muted',
      'text-faint',
      'text-on-accent',
      'accent',
      'accent-subtle',
      'ok',
      'warn',
      'err',
      'info',
      'motion-duration',
      'surface-opacity'
    ].filter((token) => style.getPropertyValue(`--lumanin-${token}`).trim().length === 0)
  })

  expect(missing).toEqual([])
})
