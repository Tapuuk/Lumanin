import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * The extension host, driven through the real window.
 *
 * Historically this was the host's gate ("an unmodified simple store extension
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
import { Action, ActionPanel, Detail, List, confirmAlert, environment, showToast, Toast, useNavigation } from "lumanin";
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
                <Action title="Confirm Marker" shortcut={{ modifiers: ["cmd"], key: "y" }} onAction={async () => {
                  if (await confirmAlert({ title: "Write it?", primaryTitle: "Write" })) {
                    writeFileSync(join(environment.supportPath, "confirmed.txt"), item);
                  }
                }} />
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

/**
 * A list far bigger than the window the renderer draws. What it proves: the DOM
 * holds a bounded number of rows, the window slides with the selection, and
 * filtering still reaches every row the plugin returned.
 */
const CROWD_SOURCE = `
import { List } from "lumanin";
import { useState } from "react";

export default function Crowd() {
  // Controlled on purpose - the shape every category dropdown has, and the
  // shape that once ping-ponged onChange between renderer and worker forever
  // when Tab was pressed faster than patches came back.
  const [flavour, setFlavour] = useState("plain");
  return (
    <List
      searchBarPlaceholder="Filter crowd"
      searchBarAccessory={
        <List.Dropdown tooltip="Flavour" value={flavour} onChange={setFlavour}>
          <List.Dropdown.Item value="plain" title="Plain" />
          <List.Dropdown.Item value="salted" title="Salted" />
          <List.Dropdown.Item value="sweet" title="Sweet" />
        </List.Dropdown>
      }
    >
      {Array.from({ length: 2000 }, (_, i) => (
        <List.Item key={i} id={String(i + 1)} title={flavour + " Row " + (i + 1)} />
      ))}
    </List>
  );
}
`

/**
 * A command that stops answering, the way a plugin accidentally does: a loop
 * with no await in it. The first commit is out and the worker is back on its
 * event loop before the loop starts, so the panel renders and *then* the thread
 * stops responding to anything — including being told its session is over.
 */
const PEG_SOURCE = `
import { List } from "lumanin";
import { useEffect } from "react";

export default function Peg() {
  useEffect(() => {
    setTimeout(() => {
      for (;;) {
        Date.now();
      }
    }, 50);
  }, []);

  return (
    <List>
      <List.Item id="pegged" title="Pegged" />
    </List>
  );
}
`

/**
 * A list that asks to hear the word rather than every letter, and writes down
 * each search text it is actually handed. One line per delivery is the only way
 * to count deliveries from outside the worker.
 */
const THROTTLED_SOURCE = `
import { Action, ActionPanel, List, environment } from "lumanin";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function TypeFast() {
  return (
    <List
      throttle
      searchBarPlaceholder="Type fast"
      onSearchTextChange={(text) =>
        writeFileSync(join(environment.supportPath, "typed.txt"), text + "\\n", { flag: "a" })
      }
    >
      {/* The action is here so the view has an action bar: that is what a test
          outside the window can watch appear and then go on Escape. */}
      <List.Item
        id="ready"
        title="Ready To Type"
        actions={
          <ActionPanel>
            <Action title="Note The Text" onAction={() => writeFileSync(join(environment.supportPath, "noted.txt"), "noted")} />
          </ActionPanel>
        }
      />
    </List>
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
    },
    {
      name: 'crowd',
      title: 'Crowd',
      description: 'Two thousand rows',
      mode: 'view'
    },
    {
      name: 'peg',
      title: 'Peg',
      description: 'A command that stops answering',
      mode: 'view'
    },
    {
      name: 'throttled',
      title: 'Type Fast',
      description: 'A list that throttles its search text',
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
/** Node's compiled-bytecode cache for the host and its workers, inside this run's XDG tree. */
let compileCacheDir: string

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

/**
 * How many worker threads the host is holding.
 *
 * A gap in the answer reads as "too many" rather than as a pass, so a poll on
 * this keeps trying instead of succeeding on a status the host never filled in.
 */
async function hostWorkers(): Promise<number> {
  const reply = await askDaemon({ kind: 'status' })
  const data = reply.data as { extensionHost?: { workers?: number | null } } | undefined
  const workers = data?.extensionHost?.workers
  return typeof workers === 'number' ? workers : Number.POSITIVE_INFINITY
}

/**
 * The worker count once it has stopped moving.
 *
 * A single read is not a baseline. A worker torn down by an earlier test may
 * not have emitted its exit yet, so the count can still be on its way down —
 * and a baseline read one too high is one a teardown reaches by doing nothing.
 * Two equal reads a beat apart are the quiet state.
 */
async function settledHostWorkers(): Promise<number> {
  let previous = Number.POSITIVE_INFINITY
  await expect
    .poll(
      async () => {
        const current = await hostWorkers()
        const steady = Number.isFinite(current) && current === previous
        previous = current
        return steady
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toBe(true)
  return previous
}

/** How many regular files sit under `dir`, at any depth. Zero when it does not exist. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).reduce((total, entry) => {
    const path = join(dir, entry)
    return total + (statSync(path).isDirectory() ? countFiles(path) : 1)
  }, 0)
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
  writeFileSync(join(source, 'src', 'crowd.tsx'), CROWD_SOURCE)
  writeFileSync(join(source, 'src', 'peg.tsx'), PEG_SOURCE)
  writeFileSync(join(source, 'src', 'throttled.tsx'), THROTTLED_SOURCE)

  // Built with the same externals the product uses, because that list is the
  // single-React rule's build half and building it any other way would test a
  // bundle nobody will ever install.
  const installed = join(root, 'data', 'lumanin', 'extensions', 'fruit')
  mkdirSync(join(installed, 'commands'), { recursive: true })
  await build({
    entryPoints: [
      join(source, 'src', 'browse.tsx'),
      join(source, 'src', 'compose.tsx'),
      join(source, 'src', 'crowd.tsx'),
      join(source, 'src', 'peg.tsx'),
      join(source, 'src', 'throttled.tsx')
    ],
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
  compileCacheDir = join(root, 'cache', 'lumanin', 'compile-cache')
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

test('the extension host is warm before anything has asked for it', async () => {
  // First in the file, and the suite runs one spec and one test at a time, so
  // nothing has launched a plugin yet. A running host with a ready spare can
  // therefore only have come from the daemon starting it by itself.
  await expect
    .poll(async () => (await askDaemon({ kind: 'status' })).data, { timeout: 20_000 })
    .toMatchObject({ extensionHost: { running: true, spare: 'ready' } })
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
    'Write Marker',
    'Confirm Marker'
  ])
  // `{modifiers: ["cmd"], key: "d"}` — cmd maps to Ctrl on Linux.
  await expect(page.locator('.overlay__key')).toHaveText(['Ctrl+D', 'Ctrl+Y'])

  await page.locator('.overlay__panel').press('Escape')
  await expect(page.locator('.overlay__panel')).toHaveCount(0)
})

test('Escape dismisses a confirmAlert without running its action', async () => {
  await page.locator('.search__input').press('Control+y')
  await expect(page.locator('.alert')).toBeVisible()
  await page.locator('.alert').press('Escape')
  await expect(page.locator('.alert')).toHaveCount(0)
  await expect(page.locator('.result__title').first()).toHaveText('Avocado')
  expect(existsSync(join(supportPath, 'confirmed.txt'))).toBe(false)
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

/**
 * The compiled-bytecode cache reached the worker threads.
 *
 * Placed after a session has ended, because the entries are written out when a
 * thread stops - polling rather than asserting once for the same reason. An
 * empty directory means the variable never reached the thread, not that the
 * cache is slow.
 */
test('the worker threads write a compiled-bytecode cache', async () => {
  await expect.poll(() => countFiles(compileCacheDir), { timeout: 20_000 }).toBeGreaterThan(0)
})

test('a pinned category launches straight into that category', async () => {
  // A category pin outranks everything once what is typed names it - the bare
  // root stays empty (a pin's job is ranking, not a permanent listing). A web
  // search row always tags along behind it once something is typed.
  await page.locator('.search__input').fill('berries')
  await expect(page.locator('.result__title').first()).toHaveText('Fruit: Berries')
  expect((await rowTitles())[0]).toEqual('Fruit: Berries')

  await page.locator('.result', { hasText: 'Fruit: Berries' }).click()
  // Only the berries render: launchContext.category crossed main → host →
  // worker → LaunchProps, which is the whole point of the plumbing.
  await expect(page.locator('.result__title').first()).toHaveText('Blueberry', { timeout: 10_000 })
  expect(await rowTitles()).toEqual(['Blueberry', 'Cranberry'])

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

test('a pinned item lands with its row selected', async () => {
  // An item pin surfaces only when what is typed names it.
  await page.locator('.search__input').fill('cranberry')
  await expect(page.locator('.result__title').first()).toHaveText('Cranberry (pinned)')
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
        icon: null,
        actions: ['Announce', 'Show Details', 'Write Marker', 'Confirm Marker']
      },
      {
        id: 'Cranberry',
        title: 'Cranberry',
        subtitle: '9 letters',
        icon: null,
        actions: ['Announce', 'Show Details', 'Write Marker', 'Confirm Marker']
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

test('a huge list draws a bounded window of rows, and search reaches past it', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/crowd' })
  expect(reply.ok).toBe(true)

  await expect(page.locator('.result__title').first()).toHaveText('plain Row 1', { timeout: 10_000 })
  // 2000 rows in the tree, a window of them in the DOM.
  await expect(page.locator('.result')).toHaveCount(150)

  // A row far beyond the window is still reachable through the filter.
  await page.locator('.search__input').fill('Row 1999')
  await expect(page.locator('.result__title').first()).toHaveText('plain Row 1999')

  // The window follows the keyboard: walking below its edge slides it.
  await page.locator('.search__input').fill('')
  await expect(page.locator('.result__title').first()).toHaveText('plain Row 1')
  for (let i = 0; i < 160; i++) await page.keyboard.press('ArrowDown')
  await expect(page.locator('.result[aria-selected="true"] .result__title')).toHaveText('plain Row 161')

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

/**
 * The other half of that window, for the hand that is not on the keyboard.
 *
 * A wheel cannot move the selection, so it cannot slide the window the way the
 * arrows do. Without a second rule the mouse reaches the last drawn row and the
 * rest of the list is simply unreachable. A sibling of the test above rather
 * than an extension of it, so that one's load flake cannot hide this one.
 */
test('scrolling with the wheel reaches rows past the drawn window', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/crowd' })
  expect(reply.ok).toBe(true)

  await expect(page.locator('.result__title').first()).toHaveText('plain Row 1', { timeout: 10_000 })
  await expect(page.locator('.result')).toHaveCount(150)

  await page.locator('.results').hover()
  for (
    let i = 0;
    i < 12 && (await page.getByText('plain Row 300', { exact: true }).count()) === 0;
    i++
  ) {
    await page.mouse.wheel(0, 4000)
    await page.waitForTimeout(100)
  }

  // Reachability, not a growth constant: how many rows one gesture reveals is
  // free to change, whether the mouse can get there is not.
  await expect(page.getByText('plain Row 300', { exact: true })).toHaveCount(1)
  expect(await page.locator('.result').count()).toBeGreaterThan(150)

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

test('cycling the category faster than patches come back settles, never loops', async () => {
  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/crowd' })
  expect(reply.ok).toBe(true)
  await expect(page.locator('.result__title').first()).toHaveText('plain Row 1', { timeout: 10_000 })

  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(page.locator('.result__title').first()).toHaveText('sweet Row 1', { timeout: 10_000 })

  // A renderer/worker onChange ping-pong keeps flipping the value after the
  // presses stop; a settled dropdown stays put.
  await page.waitForTimeout(1000)
  await expect(page.locator('.result__title').first()).toHaveText('sweet Row 1')

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)
})

/**
 * Closing a command that has stopped answering.
 *
 * The teardown asks the worker to end its session and the worker is in a loop
 * that will never read the message. Without a bound on that wait the thread is
 * never terminated: the panel goes back to the root looking fine while a thread
 * spins on with its own heap, one more of them per launch.
 */
test('a command that stops answering is still torn down', async () => {
  // The count only means something once the pool has settled: a host still
  // warming its spare holds fewer threads than its own quiet state does, and a
  // baseline taken there is one the teardown can never get back down to.
  await expect
    .poll(async () => (await askDaemon({ kind: 'status' })).data, { timeout: 20_000 })
    .toMatchObject({ extensionHost: { running: true, spare: 'ready' } })
  const baseline = await settledHostWorkers()
  expect(baseline).toBeLessThan(Number.POSITIVE_INFINITY)

  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/peg' })
  expect(reply.ok).toBe(true)
  await expect(page.locator('.result__title').first()).toHaveText('Pegged', { timeout: 10_000 })
  // Long enough for the loop to have started.
  await page.waitForTimeout(300)

  await page.locator('.search__input').press('Escape')
  await expect(page.locator('.actionbar')).toHaveCount(0)

  await expect.poll(hostWorkers, { timeout: 15_000 }).toBeLessThanOrEqual(baseline)

  // And the host is still a host: this session began with an `open` verb, so
  // Escape closed the window and the next launch needs it shown again.
  expect((await askDaemon({ kind: 'show' })).ok).toBe(true)
  expect((await askDaemon({ kind: 'open', target: 'extension:fruit/browse' })).ok).toBe(true)
  await expect(page.locator('.result__title').first()).toHaveText('Avocado', { timeout: 10_000 })
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
  await page.locator('[data-field="due"] .form__control').fill('2031-04-05')

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
 * Typing at a list that declared `throttle`.
 *
 * The collapse happens in the renderer, so nothing downstream of it can show
 * that it happened — the worker only ever sees what it was sent. Counting the
 * deliveries from the plugin's own side is the only view of it that is real.
 */
test('a throttled list is handed the word, not every letter', async () => {
  const typed = join(supportPath, 'typed.txt')
  rmSync(typed, { force: true })

  const reply = await askDaemon({ kind: 'open', target: 'extension:fruit/throttled' })
  expect(reply.ok).toBe(true)
  await expect(page.locator('.result__title').first()).toHaveText('Ready To Type', {
    timeout: 10_000
  })

  const delivered = (): string[] => {
    try {
      return readFileSync(typed, 'utf8').split('\n').filter((line) => line.length > 0)
    } catch {
      return []
    }
  }

  await page.locator('.search__input').pressSequentially('report', { delay: 0 })

  // The last text always arrives: the timer fires a beat after the typing stops.
  await expect.poll(() => delivered().at(-1) ?? '', { timeout: 10_000 }).toBe('report')
  // Not "exactly one": how many of six keystrokes land inside one window is a
  // property of the machine. Fewer than six is what proves the collapse.
  expect(delivered().length).toBeLessThan(6)

  await expect(page.locator('.actionbar')).toHaveCount(1)
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
