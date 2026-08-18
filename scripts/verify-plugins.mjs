/**
 * Does each installed plugin actually load and render its first view?
 *
 * One Electron launch, every command driven through the real window: type the
 * command title at the root, press Enter, wait for the plugin to produce
 * *something*, and record whatever arrives. A slow network fetch is a pass;
 * nothing at all is not.
 *
 *   node scripts/verify-plugins.mjs <profile-root> [--json <out>]
 *
 * `<profile-root>` is a throwaway XDG tree with plugins already installed
 * into `<root>/data/lumanin/extensions` — see `scripts/install-plugins.sh`,
 * which builds one. (This began as the machine behind the old curated
 * catalogue's `VERIFIED` claim; the catalogue is gone, but "did the thing we
 * just generated render" is the same
 * question, so the machine stayed.)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'

const repoRoot = resolve(import.meta.dirname, '..')
const root = process.argv[2]
if (root === undefined) {
  process.stderr.write('usage: node scripts/verify-plugins.mjs <profile-root> [--json <out>]\n')
  process.exit(2)
}
const jsonFlag = process.argv.indexOf('--json')
const jsonOut = jsonFlag === -1 ? join(root, 'results.json') : process.argv[jsonFlag + 1]

const extDir = join(root, 'data', 'lumanin', 'extensions')

/** Every `view`-mode command, which is the only mode that renders anything. */
const targets = []
for (const name of readdirSync(extDir).sort()) {
  const manifest = JSON.parse(readFileSync(join(extDir, name, 'package.json'), 'utf8'))
  for (const command of manifest.commands ?? []) {
    if (command.disabledByDefault === true) continue
    if ((command.mode ?? 'view') !== 'view') continue
    targets.push({ extension: name, command: command.name, title: command.title })
  }
}

/**
 * The panel must stay up between extensions.
 *
 * Written here rather than assumed of the profile, because the two defaults that
 * matter are both wrong for a harness: Esc at the root *hides* the window, and
 * losing focus hides it too. With the defaults, the first Escape after the first
 * extension left the window hidden and every command after it was recorded as
 * "not found at the root" — 36 false negatives from one setting.
 */
mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
writeFileSync(
  join(root, 'config', 'lumanin', 'config.toml'),
  '[general]\nhide_on_blur = false\nesc_at_root = "none"\n'
)

/**
 * The runtime-dir override severs more than our own socket.
 *
 * `systemctl --user` and friends find the session's buses at
 * `$XDG_RUNTIME_DIR/bus` (and systemd's private socket beside it), ignoring
 * `DBUS_SESSION_BUS_ADDRESS` — so a plugin that talks to the user session
 * would fail *only inside this harness*. Symlinking the real sockets into the
 * throwaway run dir keeps the isolation this profile is for (lumanin's own
 * socket, config, data) without detaching the machine's session services.
 */
const realRuntime = process.env['XDG_RUNTIME_DIR']
if (realRuntime !== undefined) {
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 })
  for (const name of ['bus', 'systemd']) {
    const target = join(realRuntime, name)
    const link = join(root, 'run', name)
    if (existsSync(target) && !existsSync(link)) symlinkSync(target, link)
  }
}

/**
 * Electron needs an absolute `WAYLAND_DISPLAY` when the runtime dir is
 * overridden, because it resolves the socket relative to `XDG_RUNTIME_DIR` —
 * which this harness points at the throwaway tree.
 */
function absoluteWaylandDisplay() {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

const app = await electron.launch({
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

const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 200)))
await page.waitForSelector('.search__input')

/** How long an extension gets to put its first view up. */
const RENDER_TIMEOUT_MS = 15_000

/**
 * How long it gets *after* being typed at.
 *
 * A large share of search extensions render an empty list until there is a
 * query — that is what a search command is — and the first pass recorded every
 * one of them as a timeout. Typing at it is what a person does, so the harness
 * does it too and records that it was needed.
 */
const PROBE_TIMEOUT_MS = 8_000
const PROBE_QUERY = 'a'

/** Read every signal the extension view can show, in one round trip. */
async function readView(page) {
  const [rows, detail, empty, unsupported, failed, loading] = await Promise.all([
    page.locator('.result__title').count(),
    // `.ext-detail`, not `.detail`. The wrong selector here recorded every
    // Detail-rendering command as "blank" — advice-slip, github-status and two
    // of qrcode-generator's three — which is a harness bug that reads exactly
    // like a product bug.
    page.locator('.ext-detail').count(),
    page.locator('.ext-empty__title').count(),
    page.locator('.ext-unsupported__title').count(),
    page.locator('.ext-error__title').count(),
    page.locator('.ext-loading').count()
  ])
  return { rows, detail, empty, unsupported, failed, loading }
}

/**
 * Wait for the extension to say something. `null` while it is still thinking.
 *
 * Gated on `.searchrow`, which only exists while an extension session is on
 * screen — without that gate every count below matches the *root* list, and
 * every extension is recorded as having rendered its own root row back at the
 * harness. That is exactly what the first run of this script did: 37 for 37.
 */
async function settle(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await page.locator('.searchrow').count()) === 0) {
      await page.waitForTimeout(150)
      continue
    }
    const view = await readView(page)

    if (view.failed > 0) {
      return { outcome: 'error', detail: (await page.locator('.ext-error__message').first().textContent()) ?? '' }
    }
    if (view.unsupported > 0) {
      return {
        outcome: 'unsupported',
        detail: (await page.locator('.ext-unsupported__title').first().textContent()) ?? ''
      }
    }
    if (view.rows > 0) {
      return {
        outcome: 'rows',
        detail: `${String(view.rows)} rows · ${(await page.locator('.result__title').first().textContent()) ?? ''}`
      }
    }
    if (view.detail > 0) {
      return {
        outcome: 'detail',
        detail: ((await page.locator('.ext-detail').first().textContent()) ?? '').slice(0, 60)
      }
    }
    // An empty view is a real render — but only once the extension has stopped
    // saying it is loading, or every slow fetch is recorded as "empty".
    if (view.empty > 0 && view.loading === 0) {
      return {
        outcome: 'empty',
        detail: (await page.locator('.ext-empty__title').first().textContent()) ?? ''
      }
    }
    await page.waitForTimeout(200)
  }
  return null
}

const results = []

for (const target of targets) {
  const errorsBefore = pageErrors.length
  let outcome = 'no-row'
  let detail = ''
  let neededQuery = false

  try {
    await page.locator('.search__input').fill(target.title)
    await page.waitForTimeout(250)

    const row = page.locator('.result[data-kind="extension"]').first()
    if ((await row.count()) === 0) {
      results.push({
        ...target,
        outcome,
        neededQuery,
        detail: 'command not found at the root',
        pageErrors: []
      })
      continue
    }
    await row.click()

    let settled = await settle(page, RENDER_TIMEOUT_MS)

    // Nothing yet, and the session is up: it is very likely a search command
    // waiting to be searched. Type at it before calling it a failure.
    if (settled === null && (await page.locator('.searchrow').count()) > 0) {
      await page.locator('.search__input').fill(PROBE_QUERY)
      const probed = await settle(page, PROBE_TIMEOUT_MS)
      if (probed !== null) {
        settled = { ...probed, detail: `${probed.detail}  (after typing "${PROBE_QUERY}")` }
        neededQuery = true
      }
    }

    if (settled === null) {
      outcome = (await page.locator('.searchrow').count()) > 0 ? 'blank' : 'no-session'
      detail = outcome === 'blank' ? 'the session started but drew nothing' : 'no session started'
    } else {
      outcome = settled.outcome
      detail = settled.detail
    }
  } catch (error) {
    outcome = 'threw'
    detail = String(error).slice(0, 160)
  }

  results.push({
    ...target,
    outcome,
    neededQuery,
    detail: detail.replace(/\s+/g, ' ').trim().slice(0, 90),
    pageErrors: pageErrors.slice(errorsBefore)
  })

  // Back to the root for the next one. Confirmed by the root actually answering
  // — a session that will not close is itself a result worth keeping, and
  // pressing Escape a fixed number of times and hoping is how this harness
  // produced 36 false negatives the first time it ran.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page.locator('.search__input').fill('reload theme')
    await page.waitForTimeout(150)
    if ((await page.locator('.result[data-kind="command"]').count()) > 0) break
  }
  await page.locator('.search__input').fill('')
  await page.waitForTimeout(120)
}

writeFileSync(jsonOut, JSON.stringify(results, null, 2))

for (const result of results) {
  process.stdout.write(
    `${result.outcome.padEnd(12)} ${`${result.extension}/${result.command}`.padEnd(38)} ` +
      `${result.detail}${result.pageErrors.length > 0 ? `  ERR:${result.pageErrors[0]}` : ''}\n`
  )
}
const passed = results.filter((r) => r.outcome === 'rows' || r.outcome === 'detail').length
process.stdout.write(`\n${String(passed)}/${String(results.length)} rendered a first view\n`)

await app.evaluate(({ app: instance }) => instance.exit(0)).catch(() => undefined)
await app.close().catch(() => undefined)
