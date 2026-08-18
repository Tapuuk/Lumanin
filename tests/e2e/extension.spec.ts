import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The M4 gate, driven through the real window.
 *
 * Historically this was the M4 gate ("an unmodified simple store extension
 * runs"). Since the API became the single `lumanin` module the claim it makes
 * is: a plugin written against `lumanin`, knowing nothing about the app's
 * internals, is built with our own build path, installed into a throwaway XDG
 * tree, found at the root, launched, rendered, filtered, acted on, and closed.
 *
 * It is deliberately end-to-end. Every layer in between — the reconciler, the
 * JSON Patch stream, the worker's module hook, the action panel — has its own
 * unit tests, and every one of them can pass while the thing as a whole shows a
 * blank panel.
 */

const repoRoot = resolve(__dirname, '..', '..')

function absoluteWaylandDisplay(): Record<string, string> {
  const display = process.env['WAYLAND_DISPLAY']
  const runtime = process.env['XDG_RUNTIME_DIR']
  if (display === undefined || runtime === undefined) return {}
  return { WAYLAND_DISPLAY: display.startsWith('/') ? display : join(runtime, display) }
}

/**
 * The fixture, written the way a plugin author writes one.
 *
 * Nothing here knows about the app's internals: it imports `lumanin`,
 * default-exports a component, uses hooks, and puts an `ActionPanel` in a
 * prop. If any of that needed adapting, the gate would not be met.
 */
const EXTENSION_SOURCE = `
import { Action, ActionPanel, Detail, List, environment, showToast, Toast, useNavigation } from "lumanin";
import { useEffect, useState } from "react";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

function Details({ name }: { name: string }) {
  return <Detail markdown={"# " + name + "\\n\\nA **detail** view."} />;
}

export default function Command(props: { launchContext?: { category?: string } }) {
  const [items, setItems] = useState<string[]>([]);
  const [isLoading, setLoading] = useState(true);
  const { push } = useNavigation();
  // The category contract: a launch from a pinned category arrives in
  // launchContext, and the command opens already inside it.
  const category = props.launchContext?.category ?? "fruit";

  useEffect(() => {
    const all = ["Avocado", "Blueberry", "Cranberry"];
    setItems(category === "berries" ? all.filter((f) => f.endsWith("berry")) : all);
    setLoading(false);
  }, [category]);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter fruit">
      <List.Section title="Fruit">
        {items.map((item) => (
          <List.Item
            key={item}
            id={item}
            title={item}
            subtitle={item.length + " letters"}
            accessories={[{ text: item.slice(0, 1) }]}
            actions={
              <ActionPanel>
                <Action title="Announce" onAction={() => showToast({ style: Toast.Style.Success, title: "Picked " + item })} />
                <Action title="Show Details" shortcut={{ modifiers: ["cmd"], key: "d" }} onAction={() => push(<Details name={item} />)} />
                {/* A side effect on disk, so a headless run — which shows nothing
                    by design — can still be proved to have happened. */}
                <Action title="Write Marker" onAction={() => writeFileSync(join(environment.supportPath, "marker.txt"), item)} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
`

/**
 * A form, written the way a plugin author writes one.
 *
 * Every value shape the spec has — string, boolean, one-of, many-of, date — plus
 * a controlled field, a validation error and a `ref`. What it proves is the
 * round trip: the renderer holds the values, `Action.SubmitForm` collects them,
 * and they arrive in the worker as the types the extension's own code expects.
 * The marker file is how a test sees that from outside.
 */
const FORM_SOURCE = `
import { Action, ActionPanel, Form, LaunchType, environment, launchCommand } from "lumanin";
import { useRef, useState } from "react";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function Compose() {
  const [error, setError] = useState<string | undefined>(undefined);
  // Controlled on purpose: the worker owns this one, and it must not fight the
  // renderer's copy on every unrelated re-render.
  const [tag, setTag] = useState("green");
  const notes = useRef<Form.TextArea>(null);

  return (
    <Form
      navigationTitle="Compose"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save"
            onSubmit={(values) => {
              if (!values.name) {
                setError("Name is required");
                return;
              }
              setError(undefined);
              writeFileSync(
                join(environment.supportPath, "form.json"),
                JSON.stringify({
                  ...values,
                  // Proves the date arrived as a Date and not as the wire shape.
                  dueIsDate: values.due instanceof Date,
                })
              );
            }}
          />
          <Action title="Focus Notes" onAction={() => notes.current?.focus()} />
          {/* One command handing off to another, with a launch context. */}
          <Action
            title="Browse Berries"
            onAction={() =>
              launchCommand({
                name: "browse",
                type: LaunchType.UserInitiated,
                context: { category: "berries" },
              })
            }
          />
        </ActionPanel>
      }
    >
      <Form.Description text="Describe the thing." />
      <Form.TextField id="name" title="Name" autoFocus error={error} placeholder="What is it" />
      <Form.TextArea id="notes" title="Notes" ref={notes} />
      <Form.Separator />
      <Form.Checkbox id="urgent" title="Urgent" label="Needs doing today" />
      <Form.Dropdown id="colour" title="Colour" value={tag} onChange={setTag}>
        <Form.Dropdown.Item value="green" title="Green" />
        <Form.Dropdown.Item value="red" title="Red" />
      </Form.Dropdown>
      <Form.TagPicker id="tags" title="Tags">
        <Form.TagPicker.Item value="one" title="One" />
        <Form.TagPicker.Item value="two" title="Two" />
      </Form.TagPicker>
      <Form.DatePicker id="due" title="Due" type={Form.DatePicker.Type.Date} />
    </Form>
  );
}
`

const MANIFEST = {
  name: 'fruit',
  title: 'Fruit',
  description: 'A fixture extension for the extension-host end-to-end suite',
  author: 'lumanin',
  license: 'MIT',
  categories: ['Other'],
  commands: [
    {
      name: 'browse',
      title: 'Browse Fruit',
      description: 'List some fruit',
      mode: 'view',
      lumanin: {
        categories: [
          { id: 'fruit', title: 'Fruit' },
          { id: 'berries', title: 'Berries' }
        ]
      }
    },
    {
      name: 'compose',
      title: 'Compose Fruit',
      description: 'A form with every field kind',
      mode: 'view'
    }
  ]
}

let app: ElectronApplication
let page: Page
let socketPath: string
/** The fixture's `environment.supportPath`, where its marker action writes. */
let supportPath: string
/** Where the fixture was installed, for the test that takes its files away. */
let installedDir: string

/** One request over the daemon's real control socket, one reply back. */
function askDaemon(verb: object): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.end()
      resolvePromise(JSON.parse(buffer.slice(0, newline)) as never)
    })
    socket.write(JSON.stringify({ id: 1, verb }) + '\n')
  })
}

async function rowTitles(): Promise<string[]> {
  return page.locator('.result__title').allTextContents()
}

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumanin-ext-e2e-'))
  const source = join(root, 'source')
  mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify(MANIFEST, null, 2))
  writeFileSync(join(source, 'src', 'browse.tsx'), EXTENSION_SOURCE)
  writeFileSync(join(source, 'src', 'compose.tsx'), FORM_SOURCE)

  // Built with the same externals the product uses, because that list is the
  // single-React rule's build half and building it any other way would test a
  // bundle nobody will ever install.
  const installed = join(root, 'data', 'lumanin', 'extensions', 'fruit')
  mkdirSync(join(installed, 'commands'), { recursive: true })
  await build({
    entryPoints: [join(source, 'src', 'browse.tsx'), join(source, 'src', 'compose.tsx')],
    outdir: join(installed, 'commands'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    jsx: 'automatic',
    logLevel: 'silent',
    external: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'lumanin'
    ]
  })
  cpSync(join(source, 'package.json'), join(installed, 'package.json'))

  mkdirSync(join(root, 'config', 'lumanin'), { recursive: true })
  writeFileSync(
    join(root, 'config', 'lumanin', 'config.toml'),
    '[general]\nhide_on_blur = false\n' +
      '[search]\npins = ["extension:fruit/browse#berries",\n' +
      '  { id = "extension:fruit/browse#berries:Cranberry", title = "Cranberry (pinned)" }]\n'
  )

  app = await electron.launch({
    args: [repoRoot, '--show'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_RUNTIME_DIR: join(root, 'run'),  // socketPath below lives here
      ...absoluteWaylandDisplay(),
      LUMANIN_HIDE_ON_BLUR: 'false'
    }
  })

  socketPath = join(root, 'run', 'lumanin.sock')
  supportPath = join(installed, 'support')
  installedDir = installed
  page = await app.firstWindow()
  await page.waitForSelector('.search__input')
})

test.afterAll(async () => {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.exit(0)
  })
  await app.close().catch(() => undefined)
})

test('an installed extension command appears at the root', async () => {
  await page.locator('.search__input').fill('browse fruit')
  await expect(page.locator('.result[data-kind="extension"]').first()).toBeVisible()
  await expect(page.locator('.result__title').first()).toHaveText('Browse Fruit')
})

test('launching it renders the extension’s list', async () => {
  await page.locator('.search__input').fill('browse fruit')
  await page.locator('.result').first().click()

  // The list arrives in two batches — the first render is empty and loading, the
  // effect's state update fills it — so this waits for the second.
  await expect(page.locator('.result__title').first()).toHaveText('Avocado', { timeout: 10_000 })
  expect(await rowTitles()).toEqual(['Avocado', 'Blueberry', 'Cranberry'])

  // The section header, the subtitle and the accessory all come from props that
  // had to survive the reconciler, the patch stream and the player.
  await expect(page.locator('.results__section')).toHaveText('Fruit')
  await expect(page.locator('.result__subtitle').first()).toHaveText('7 letters')
  await expect(page.locator('.result__accessory').first()).toHaveText('A')

  // The extension's own placeholder replaced ours.
  await expect(page.locator('.search__input')).toHaveAttribute('placeholder', 'Filter fruit')
})

test('the search bar filters the list in the renderer', async () => {
  await page.locator('.search__input').fill('berry')
  await expect(page.locator('.result__title')).toHaveCount(2)
  expect(await rowTitles()).toEqual(['Blueberry', 'Cranberry'])

  // The launcher's search rules, not a substring scan: one typo is forgiven…
  await page.locator('.search__input').fill('bluberry')
  await expect(page.locator('.result__title')).toHaveCount(1)
  expect(await rowTitles()).toEqual(['Blueberry'])

  // …and the subtitle never matches. Every fixture row's subtitle says
  // "N letters", so this once matched all three.
  await page.locator('.search__input').fill('letters')
  await expect(page.locator('.result__title')).toHaveCount(0)

  await page.locator('.search__input').fill('')
  await expect(page.locator('.result__title')).toHaveCount(3)

  // Editing the query selects the top row again, exactly as the root list does —
  // selecting by id means a surviving row would otherwise keep the cursor, and
  // the highlight would be stranded on row two of a list just re-opened.
  await expect(page.locator('.result[aria-selected="true"] .result__title')).toHaveText('Avocado')
})

test('the action bar names what Enter does, and Enter does it', async () => {
  await expect(page.locator('.actionbar__label')).toHaveText('Announce')

  await page.locator('.search__input').press('Enter')
  await expect(page.locator('.toast')).toBeVisible()
  await expect(page.locator('.toast__title')).toHaveText('Picked Avocado')
  await expect(page.locator('.toast')).toHaveClass(/toast--success/)
})

test('Ctrl+K opens the action panel and lists the shortcut', async () => {
  await page.locator('.search__input').press('Control+k')
  await expect(page.locator('.overlay__panel')).toBeVisible()
  expect(await page.locator('.overlay__label').allTextContents()).toEqual([
    'Announce',
    'Show Details',
    'Write Marker'
  ])
  // `{modifiers: ["cmd"], key: "d"}` — cmd maps to Ctrl on Linux (CLAUDE.md §Keys).
  await expect(page.locator('.overlay__key')).toHaveText('Ctrl+D')

  await page.locator('.overlay__panel').press('Escape')
  await expect(page.locator('.overlay__panel')).toHaveCount(0)
})

test('an action can push a view, and Esc pops it', async () => {
  await page.locator('.search__input').press('Control+d')
  await expect(page.locator('.ext-detail')).toBeVisible()
  await expect(page.locator('.md__heading')).toHaveText('Avocado')
  await expect(page.locator('.md__paragraph strong')).toHaveText('detail')

  // At depth 2 the bar says Esc goes back rather than out.
  await expect(page.locator('.actionbar__hint')).toContainText('Back')

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.result__title').first()).toHaveText('Avocado')
})

test('Esc at the extension’s root returns to the launcher', async () => {
  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
  await expect(page.locator('.search__input')).toHaveAttribute('placeholder', 'Search...')
})

test('a pinned category launches straight into that category', async () => {
  // The empty root is the pins, and only the pins.
  await page.locator('.search__input').fill('')
  await expect(page.locator('.result__title').first()).toHaveText('Fruit: Berries')
  expect(await rowTitles()).toEqual(['Fruit: Berries', 'Cranberry (pinned)'])

  await page.locator('.result', { hasText: 'Fruit: Berries' }).click()
  // Only the berries render: launchContext.category crossed main → host →
  // worker → LaunchProps, which is the whole point of the plumbing.
  await expect(page.locator('.result__title').first()).toHaveText('Blueberry', { timeout: 10_000 })
  expect(await rowTitles()).toEqual(['Blueberry', 'Cranberry'])

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

test('a pinned item lands with its row selected', async () => {
  await expect(page.locator('.result__title').first()).toHaveText('Fruit: Berries')
  await page.locator('.result', { hasText: 'Cranberry (pinned)' }).click()

  await expect(page.locator('.result__title').first()).toHaveText('Blueberry', { timeout: 10_000 })
  // Not the top row: the launch asked for Cranberry by id, and the renderer
  // moved the cursor there once the row existed.
  await expect(page.locator('.result[aria-selected="true"] .result__title')).toHaveText('Cranberry')

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

test('the daemon answers enumerate with the rows of one category', async () => {
  // Headless: nothing on screen may change while this runs.
  const reply = await askDaemon({ kind: 'enumerate', command: 'fruit/browse', category: 'berries' })
  expect(reply.ok).toBe(true)
  // Each row reports its actions by title, which is what a key can be bound to.
  expect(reply.data).toEqual({
    items: [
      {
        id: 'Blueberry',
        title: 'Blueberry',
        subtitle: '9 letters',
        actions: ['Announce', 'Show Details', 'Write Marker']
      },
      {
        id: 'Cranberry',
        title: 'Cranberry',
        subtitle: '9 letters',
        actions: ['Announce', 'Show Details', 'Write Marker']
      }
    ]
  })
})

test('an action target runs the action and never opens a window', async () => {
  // The panel is showing the root list; a key bound to an action must leave it
  // exactly there. Nothing about this launch is visible — that is the point of
  // binding an action rather than a category.
  await page.locator('.search__input').fill('')
  const before = await rowTitles()

  const reply = await askDaemon({
    kind: 'open',
    target: 'extension:fruit/browse#berries:Cranberry!Write Marker'
  })
  expect(reply.ok).toBe(true)

  // It really ran: the action wrote its marker from inside a headless worker.
  // Polled, not read once — the daemon's reply says the action was dispatched,
  // and `onAction` is fire-and-forget by design, so the write lands a beat
  // later on a slow machine.
  await expect
    .poll(
      () => {
        try {
          return readFileSync(join(supportPath, 'marker.txt'), 'utf8')
        } catch {
          return null
        }
      },
      { timeout: 10_000 }
    )
    .toBe('Cranberry')

  // And the window never became the plugin's.
  await expect(page.locator('.actionbar')).toHaveCount(0)
  expect(await rowTitles()).toEqual(before)
})

test('an action target names the action by title, and says so when it is gone', async () => {
  const reply = await askDaemon({
    kind: 'open',
    target: 'extension:fruit/browse#berries:Cranberry!Delete Everything'
  })
  expect(reply.ok).toBe(false)
  expect(reply.error).toContain('Delete Everything')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

test('the open verb — what a hotkey bind runs — lands inside the category', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/browse#berries' })
  expect(reply.ok).toBe(true)

  await expect(page.locator('.result__title').first()).toHaveText('Blueberry', { timeout: 10_000 })
  expect(await rowTitles()).toEqual(['Blueberry', 'Cranberry'])

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

// --- Form --------------------------------------------------------------------

/**
 * The form, end to end.
 *
 * The point of doing this in a real window rather than in a unit test: the
 * values live in the renderer, the submit collects them there, and they cross
 * two process boundaries before the extension's `onSubmit` sees them. Every
 * seam in that chain is one where a value can arrive as the wrong type, and none
 * of them is visible from either end on its own.
 */
test('a form renders every field kind it declares', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/compose' })
  expect(reply.ok).toBe(true)

  await expect(page.locator('.form')).toBeVisible({ timeout: 10_000 })
  // The navigation title takes the search field's place: there is no query to
  // type into a form.
  await expect(page.locator('.ext-title')).toHaveText('Compose')
  await expect(page.locator('.search__input')).toHaveCount(0)

  expect(await page.locator('.form__title').allTextContents()).toEqual([
    'Name',
    'Notes',
    'Urgent',
    'Colour',
    'Tags',
    'Due'
  ])
  await expect(page.locator('.form__description')).toHaveText('Describe the thing.')
  await expect(page.locator('.form__separator')).toHaveCount(1)

  // `autoFocus` put the caret in the first field without anyone pressing a key.
  await expect(page.locator('[data-field="name"] .form__control')).toBeFocused()
})

test('a ref can move the focus', async () => {
  await page.keyboard.press('Control+k')
  await page.locator('.overlay__row', { hasText: 'Focus Notes' }).click()
  await expect(page.locator('[data-field="notes"] .form__control')).toBeFocused()
})

test('an empty required field comes back as an error on the field', async () => {
  // Enter submits from anywhere in the form except a text area, which keeps it
  // for newlines — so the caret is put somewhere else first.
  await page.locator('[data-field="name"] .form__control').focus()
  await page.keyboard.press('Enter')

  await expect(page.locator('.form__error')).toHaveText('Name is required')
  await expect(page.locator('.form__row--error')).toHaveCount(1)
})

test('submitting sends every value in the type the extension declared', async () => {
  await page.locator('[data-field="name"] .form__control').fill('Marmalade')
  await page.locator('[data-field="notes"] .form__control').fill('two\nlines')
  await page.locator('[data-field="urgent"] .form__control').check()
  await page.locator('[data-field="colour"] .form__control').selectOption('red')
  await page.locator('.form__tag', { hasText: 'Two' }).click()
  await page.locator('[data-field="due"] .form__control').fill('2026-08-10')

  await page.locator('[data-field="name"] .form__control').focus()
  await page.keyboard.press('Enter')

  await expect(page.locator('.form__error')).toHaveCount(0)
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(join(supportPath, 'form.json'), 'utf8')) as unknown
      } catch {
        return null
      }
    }, { timeout: 10_000 })
    .toMatchObject({
      name: 'Marmalade',
      notes: 'two\nlines',
      urgent: true,
      colour: 'red',
      tags: ['two'],
      // The one that cannot be faked: a `{__date}` on the wire has to be a real
      // `Date` by the time the extension's own code touches it.
      dueIsDate: true
    })
})

/**
 * A controlled field is the worker's, and it must not fight the renderer.
 *
 * `colour` has a `value` prop driven by the worker's own state. Choosing a new
 * one has to stick — the failure this guards is the classic one, where the next
 * unrelated re-render pushes the old value back and the control snaps back on
 * its own.
 */
test('a controlled field keeps the value the user chose', async () => {
  await expect(page.locator('[data-field="colour"] .form__control')).toHaveValue('red')
  await page.locator('[data-field="name"] .form__control').fill('a different name')
  await expect(page.locator('[data-field="colour"] .form__control')).toHaveValue('red')

  await page.keyboard.press('Escape')
  await expect(page.locator('.form')).toHaveCount(0)
})

/**
 * `launchCommand` — one command starting another.
 *
 * The same machinery a pinned category uses, reached from inside a plugin
 * instead of from the root: `context` becomes the target's `launchContext`, so a
 * command written to be launched from a pin is already written to be launched
 * from here. That reuse is the whole design, and this is what proves it.
 */
test('a command can launch another one, with a context', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/compose' })
  expect(reply.ok).toBe(true)
  await expect(page.locator('.form')).toBeVisible({ timeout: 10_000 })

  await page.keyboard.press('Control+k')
  await page.locator('.overlay__row', { hasText: 'Browse Berries' }).click()

  // The panel is now the other command's, and it opened inside the category the
  // launch named rather than at its own default.
  await expect(page.locator('.result__title').first()).toHaveText('Blueberry', { timeout: 10_000 })
  expect(await rowTitles()).toEqual(['Blueberry', 'Cranberry'])

  // This session began with an `open` verb, so there is no root list behind it
  // and Escape closes the window — even after `launchCommand` swapped the
  // command inside it. Shown again for whatever runs next, which is what the
  // user would do by pressing their hotkey.
  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
  expect((await askDaemon({ kind: 'show' })).ok).toBe(true)
})

/**
 * The index is a snapshot; the directory is the truth.
 *
 * Removing a plugin's files out from under a running daemon is not a corner
 * case — `rm -rf`, a package upgrade, an interrupted install and a second
 * checkout's `ext dev` all do it. What the user saw before this was Node's:
 * a red `Cannot find module` naming an absolute path inside a worker, for a row
 * the root was still offering. And because the scratch directory was created
 * before the entry was loaded, a plugin that was not installed kept leaving a
 * support tree behind as evidence that it was.
 */
test('a command whose files went away says so, and stops being offered', async () => {
  rmSync(join(installedDir, 'commands', 'compose.js'))

  await page.locator('.search__input').press('Escape')
  // Escape hid the window, and a hidden Wayland surface gets no frame
  // callbacks — Playwright's click waits on two rAFs, so clicking while
  // hidden hangs until the timeout. Show it again first, like a user would.
  expect((await askDaemon({ kind: 'show' })).ok).toBe(true)
  await page.locator('.search__input').fill('compose fruit')
  await expect(page.locator('.result__title').first()).toHaveText('Compose Fruit')
  await page.locator('.result').first().click()

  // A sentence, and one that is true: the lookup rescanned, found the command
  // really was gone, and said so. What it must never be again is Node's —
  // `Cannot find module` and an absolute path, thrown inside a worker.
  const notice = page.locator('.notice')
  await expect(notice).toContainText('no longer installed', { timeout: 10_000 })
  await expect(notice).not.toContainText('Cannot find module')

  // The failed launch rescanned, so the row is gone rather than waiting there to
  // fail again — and nothing recreated the directory the entry lived in.
  // Cleared first: refilling the box with the text it already holds fires no
  // change event, so the list would be the one from before the rescan. Polled
  // with a fresh refill per attempt, because the rescan runs after the error
  // card and a single early refill can race it under a loaded machine.
  await expect
    .poll(
      async () => {
        await page.locator('.search__input').fill('')
        await page.locator('.search__input').fill('compose fruit')
        // Anchored and case-sensitive: `hasText` with a string is neither, and
        // the web fallback "Search Google for “compose fruit”" matches it.
        return page.locator('.result__title').filter({ hasText: /^Compose Fruit$/ }).count()
      },
      { timeout: 10_000 }
    )
    .toBe(0)
  expect(existsSync(join(installedDir, 'commands', 'compose.js'))).toBe(false)
})
