import { createElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import * as shim from '../src/api-shim'
// The data-loading half is a separate module; `lumanin` merges the two.
import * as utils from '../src/api-shim/utils'
import { installRuntime, type ShimRuntime } from '../src/api-shim/runtime'
import { PlatformNotSupportedError, unsupportedApis } from '../src/api-shim/unsupported'
import { APP_METHODS, type SessionSpec } from '../src/shared/ext-protocol'
import { INTERNAL_TYPES } from '../src/shared/render-tree'
import { createRenderer } from '../src/host/reconciler'
import { serializeTree } from '../src/host/tree'
import type { RenderNode } from '../src/shared/render-tree'

/**
 * The api-shim, against a fake runtime.
 *
 * The whole reason `ShimRuntime` is an injected interface rather than a direct
 * import of the worker: the entire API surface can be exercised here with no
 * thread, no utilityProcess and no Electron, so the tests that matter — does an
 * action reach the clipboard, does a slot end up as a child, is every deprecated
 * alias exported — run in milliseconds on every save.
 */

interface Recorded {
  readonly method: string
  readonly params: unknown
}

const calls: Recorded[] = []
const notifications: Recorded[] = []
const handlers = new Map<string, (payload: unknown) => void>()
let answer: unknown = null

const SPEC: SessionSpec = {
  sessionId: 's1',
  extensionName: 'fixture',
  extensionTitle: 'Fixture',
  extensionDir: '/tmp/fixture',
  commandName: 'run',
  commandTitle: 'Run',
  commandMode: 'view',
  entryPath: '/tmp/fixture/commands/run.js',
  launchContext: {},
  preferences: { token: 'abc', count: 3 },
  launchArguments: {},
  environment: {
    assetsPath: '/tmp/fixture/assets',
    supportPath: '/tmp/fixture/support',
    appearance: 'dark',
    textSize: 'medium',
    isDevelopment: false,
    launchType: 'userInitiated',
    apiVersion: '1.104.24'
  }
}

let counter = 0

const runtime: ShimRuntime = {
  spec: SPEC,
  call: async (method, params) => {
    calls.push({ method, params })
    return await Promise.resolve(answer as never)
  },
  notify: (method, params) => notifications.push({ method, params }),
  setHandler: (id, handler) => {
    if (handler === null) handlers.delete(id)
    else handlers.set(id, handler)
    return id
  },
  nextHandlerId: () => `h${++counter}`,
  scheduleRender: () => {}
}

installRuntime(runtime)

beforeEach(() => {
  calls.length = 0
  notifications.length = 0
  handlers.clear()
  answer = null
})

/** Render an element the way a worker would, and return the serialized tree. */
function render(element: ReactNode): RenderNode {
  const renderer = createRenderer({ onCommit: () => {}, onError: (error) => { throw error } })
  renderer.render(element)
  const { node } = serializeTree(renderer.root, {
    handler: (id, fn) => handlers.set(id, fn),
    reject: () => {}
  })
  return node
}

function find(node: RenderNode, type: string): RenderNode | null {
  if (node.type === type) return node
  for (const child of node.children) {
    if ((child as RenderNode).type === undefined) continue
    const found = find(child as RenderNode, type)
    if (found !== null) return found
  }
  return null
}

describe('element shape', () => {
  /**
   * The hoist that makes `actions` work at all. A reconciler renders children,
   * never props, so an `ActionPanel` left in a prop would be serialized as a
   * lump of React internals with its actions never mounted.
   */
  it('hoists an element-valued prop into a slot child', () => {
    const tree = render(
      createElement(shim.List.Item, {
        title: 'Row',
        actions: createElement(
          shim.ActionPanel,
          null,
          createElement(shim.Action, { title: 'Go' })
        )
      })
    )

    const item = find(tree, 'List.Item')
    expect(item).not.toBeNull()
    expect(item?.props['actions']).toBeUndefined()

    const slot = item?.children[0] as RenderNode
    expect(slot.type).toBe(INTERNAL_TYPES.SLOT)
    expect(slot.props['name']).toBe('actions')
    expect((slot.children[0] as RenderNode).type).toBe('ActionPanel')
  })

  it('produces no slot at all for a null actions prop', () => {
    const tree = render(createElement(shim.List.Item, { title: 'Row', actions: null }))
    expect(find(tree, 'List.Item')?.children).toEqual([])
  })

  it('normalises a shortcut to the wire form on the way out', () => {
    const tree = render(
      createElement(shim.Action, { title: 'Copy', shortcut: { modifiers: ['cmd'], key: 'c' } })
    )
    expect(find(tree, 'Action')?.props['shortcut']).toBe('ctrl+c')
  })

  it('names components by their dotted wire type', () => {
    const tree = render(
      createElement(
        shim.List,
        null,
        createElement(shim.List.Section, { title: 'S' }, createElement(shim.List.Item, { title: 'I' }))
      )
    )
    expect(find(tree, 'List')).not.toBeNull()
    expect(find(tree, 'List.Section')).not.toBeNull()
    expect(find(tree, 'List.Item')).not.toBeNull()
  })

  /**
   * Every convenience action renders a plain `<Action>`, so the renderer draws
   * one kind of row and dispatches one kind of handler — and everything that
   * makes a copy action a *copy* action stays next to the clipboard call it has
   * to make.
   */
  it('renders every convenience action as a plain Action', () => {
    const tree = render(
      createElement(
        shim.ActionPanel,
        null,
        createElement(shim.Action.CopyToClipboard, { content: 'x' }),
        createElement(shim.Action.OpenInBrowser, { url: 'https://example.com' }),
        createElement(shim.Action.Trash, { paths: '/tmp/x' })
      )
    )
    const panel = find(tree, 'ActionPanel')
    expect(panel?.children.map((child) => (child as RenderNode).type)).toEqual([
      'Action',
      'Action',
      'Action'
    ])
    expect((panel?.children[0] as RenderNode).props['title']).toBe('Copy to Clipboard')
    expect((panel?.children[1] as RenderNode).props['title']).toBe('Open in Browser')
    expect((panel?.children[2] as RenderNode).props['style']).toBe('destructive')
  })
})

describe('actions do what they say', () => {
  it('Action.CopyToClipboard copies, then closes with a HUD', async () => {
    const tree = render(createElement(shim.Action.CopyToClipboard, { content: 'hello' }))
    const handlerId = (find(tree, 'Action')?.props['onAction'] as { __handler: string }).__handler

    handlers.get(handlerId)?.(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls.map((call) => call.method)).toEqual([
      APP_METHODS.CLIPBOARD_COPY,
      APP_METHODS.CLOSE_WINDOW
    ])
    expect(calls[0]?.params).toMatchObject({ text: 'hello', concealed: false })
    expect(notifications.some((entry) => entry.method === APP_METHODS.HUD)).toBe(true)
  })

  it('passes `concealed` through, because the clipboard history depends on it', async () => {
    const tree = render(
      createElement(shim.Action.CopyToClipboard, { content: 'secret', concealed: true })
    )
    const handlerId = (find(tree, 'Action')?.props['onAction'] as { __handler: string }).__handler
    handlers.get(handlerId)?.(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[0]?.params).toMatchObject({ concealed: true })
  })

  it('runs the extension’s own callback after the effect, not before', async () => {
    const order: string[] = []
    const tree = render(
      createElement(shim.Action.OpenInBrowser, {
        url: 'https://example.com',
        onOpen: () => order.push('onOpen')
      })
    )
    const handlerId = (find(tree, 'Action')?.props['onAction'] as { __handler: string }).__handler
    handlers.get(handlerId)?.(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls[0]?.method).toBe(APP_METHODS.OPEN)
    expect(order).toEqual(['onOpen'])
  })
})

describe('feedback', () => {
  it('showToast sends the toast and keeps its action reachable', async () => {
    let pressed = false
    const toast = await shim.showToast({
      style: shim.Toast.Style.Success,
      title: 'Done',
      primaryAction: { title: 'Undo', onAction: () => (pressed = true) }
    })

    const shown = notifications.find((entry) => entry.method === APP_METHODS.TOAST_SHOW)
    expect(shown?.params).toMatchObject({ style: 'SUCCESS', title: 'Done' })

    const handlerId = (shown?.params as { primaryAction: { handlerId: string } }).primaryAction
      .handlerId
    handlers.get(handlerId)?.(undefined)
    expect(pressed).toBe(true)

    // A mutated toast is pushed again — the spec's own example is assigning to
    // `toast.style` after an await.
    toast.style = shim.Toast.Style.Failure
    const updates = notifications.filter((entry) => entry.method === APP_METHODS.TOAST_SHOW)
    expect((updates[updates.length - 1]?.params as { style: string }).style).toBe('FAILURE')
  })

  it('supports the deprecated positional showToast, which half the store uses', async () => {
    await shim.showToast(shim.Toast.Style.Failure, 'Nope', 'it did not work')
    expect(notifications[0]?.params).toMatchObject({
      style: 'FAILURE',
      title: 'Nope',
      message: 'it did not work'
    })
  })

  it('confirmAlert returns the answer and calls the matching action', async () => {
    answer = true
    let confirmed = false
    const result = await shim.confirmAlert({
      title: 'Delete it?',
      primaryAction: {
        title: 'Delete',
        style: shim.Alert.ActionStyle.Destructive,
        onAction: () => (confirmed = true)
      }
    })

    expect(result).toBe(true)
    expect(confirmed).toBe(true)
    expect(calls[0]).toMatchObject({
      method: APP_METHODS.ALERT,
      params: { title: 'Delete it?', primaryTitle: 'Delete', destructive: true }
    })
  })
})

describe('environment and preferences', () => {
  it('reads preferences that main already resolved', () => {
    expect(shim.getPreferenceValues()).toEqual({ token: 'abc', count: 3 })
  })

  it('reports the session’s environment', () => {
    expect(shim.environment.extensionName).toBe('fixture')
    expect(shim.environment.commandName).toBe('run')
    expect(shim.environment.appearance).toBe('dark')
    expect(shim.environment.raycastVersion).toBe('1.104.24')
    expect(shim.environment.launchType).toBe(shim.LaunchType.UserInitiated)
    expect(shim.environment.extensionPath).toBe('/tmp/fixture')
    expect(shim.environment.extensionPath).not.toBe(shim.environment.assetsPath)
  })

  /**
   * `canAccess` exists so an extension can choose a fallback. An optimistic
   * `true` removes the fallback and makes it fail later, further from the cause.
   */
  it('canAccess answers false for what we cannot do', () => {
    expect(shim.environment.canAccess(shim.getSelectedFinderItems)).toBe(false)
    expect(shim.environment.canAccess(shim.AI)).toBe(false)
    expect(shim.environment.canAccess(shim.showToast)).toBe(true)
  })
})

describe('the unsupported surface', () => {
  it('throws rather than returning nothing', () => {
    expect(() => shim.getSelectedFinderItems()).toThrow(PlatformNotSupportedError)
    expect(() => shim.showInFinder('/tmp/x')).toThrow(/macOS-only/)
    expect(() => shim.BrowserExtension.getTabs()).toThrow(PlatformNotSupportedError)
  })

  /**
   * The registry is not decoration: the store's compatibility scanner is built
   * out of exactly this set, derived at scan time so the two cannot drift.
   */
  it('records every unsupported member with a reason', () => {
    const apis = unsupportedApis()
    expect(apis.length).toBeGreaterThan(0)
    expect(apis.map((entry) => entry.api)).toContain('getSelectedFinderItems')
    expect(apis.every((entry) => entry.reason.length > 0)).toBe(true)
  })

  /**
   * An API that is merely unbuilt must **not** be in that registry: the scanner
   * would read it as "this extension cannot work on Linux", which is a claim
   * about the platform rather than about our schedule.
   */
  it('does not condemn APIs that are simply not built yet', () => {
    const names = unsupportedApis().map((entry) => entry.api)
    expect(names).not.toContain('Action.PickDate')
    // Cut, not unbuilt: WindowManagement is declined, and says so without blaming Linux.
    expect(names).not.toContain('WindowManagement.getActiveWindow')
    expect(() => shim.WindowManagement.getActiveWindow()).toThrow(/window manager/)
  })
})

/**
 * A stub is only honest if something outside it can see that it is one.
 *
 * `scripts/compat-coverage.mjs` reads these marks to separate *built* from
 * *named*. Without them the ratio counts names, which is how the coverage number
 * once reported 88/88 with `Form`, `Grid`, `launchCommand` and six hooks unwritten — the
 * exact hole the number existed to prevent.
 */
describe('stubs are marked so coverage cannot be fooled', () => {
  const PENDING = Symbol.for('lumanin.pending')
  const UNSUPPORTED = Symbol.for('lumanin.unsupported')
  const DECLINED = Symbol.for('lumanin.declined')

  it('marks what is unbuilt with the reason it is unbuilt', () => {
    expect((shim.Action.PickDate as unknown as Record<symbol, string>)[PENDING]).toMatch(
      /date picker/
    )
    // And what was cut carries the declined mark, not the pending one.
    expect(
      (shim.WindowManagement.getActiveWindow as unknown as Record<symbol, string>)[DECLINED]
    ).toMatch(/window manager/)
  })

  it('says a stub is unbuilt in the same shape every time', () => {
    expect(() => (utils.useSQL as unknown as () => void)()).toThrow(/not implemented yet: /)
  })

  /**
   * A component the renderer has no case for reaches the "not supported yet"
   * card. Nothing about the shim can tell you that, so the shim has to say so
   * itself — and it must stay a component, because the card names the element
   * and says the extension is fine, which a stack trace does not.
   */
  it('marks components that exist but are not drawn yet', () => {
    expect((shim.Grid as unknown as Record<symbol, string>)[PENDING]).toMatch(/List with icons/)
    expect(typeof shim.Grid).toBe('function')
    expect(shim.environment.canAccess(shim.Grid)).toBe(false)
  })

  /**
   * `throwingAction` wraps its thrower in a component, which buries the mark in
   * a closure. Left there, `canAccess(Action.ShowInFinder)` answers `true` for
   * an action that throws the moment it is pressed.
   */
  it('carries a mark out through the component that wraps it', () => {
    const showInFinder = shim.Action.ShowInFinder as unknown as Record<symbol, string>
    expect(showInFinder[UNSUPPORTED]).toMatch(/macOS-only/)
    expect(shim.environment.canAccess(shim.Action.ShowInFinder)).toBe(false)
    expect(shim.environment.canAccess(shim.Action.CopyToClipboard)).toBe(true)
  })

  /**
   * Three claims, never two at once. Pending is our schedule, unsupported is
   * Linux, declined is a decision — and they are three different answers to
   * "what do I do instead", so a member claiming two says nothing.
   */
  it('never marks the same member with more than one reason', () => {
    const members = [shim.Action.PickDate, shim.Action.ShowInFinder, shim.Grid, shim.OAuth]
    for (const member of members) {
      const marks = member as unknown as Record<symbol, string>
      const claimed = [PENDING, UNSUPPORTED, DECLINED].filter((mark) => mark in marks)
      expect(claimed).toHaveLength(1)
    }
  })
})

/**
 * No sign-in: zero online services, fully local.
 *
 * The point of these is that OAuth is *declined*, not pending. A `pending` mark
 * would tell a plugin author to wait for something that is never coming, and
 * `unsupported` would blame Linux for a choice we made.
 */
describe('there is no sign-in, and it says what to do instead', () => {
  const DECLINED = Symbol.for('lumanin.declined')

  it('refuses every OAuth entry point', () => {
    expect(() => new (shim.OAuth.PKCEClient as unknown as new () => unknown)()).toThrow(
      /not available in Lumanin/
    )
    expect(() => (utils.OAuthService as unknown as () => void)()).toThrow(/not available in Lumanin/)
    expect(() => (utils.getAccessToken as unknown as () => void)()).toThrow(/password/)
    expect(() => (utils.withAccessToken as unknown as () => void)()).toThrow(/sign-in/)
  })

  /**
   * A refusal that does not say what to do instead is a dead end. Every one of
   * these names the route that does work, because the plugin author reading it
   * has no other way to find out that preferences are the answer.
   */
  it('names the alternative rather than just refusing', () => {
    const marks = shim.OAuth as unknown as Record<symbol, string>
    expect(marks[DECLINED]).toMatch(/password/)
    expect(marks[DECLINED]).toMatch(/getPreferenceValues/)
  })

  /** Throwing at construction: an extension builds its client at module scope. */
  it('fails at construction, not at the sign-in button', () => {
    expect(() => new (shim.OAuth.PKCEClient as unknown as new () => unknown)()).toThrow(/OAuth/)
  })

  /** `canAccess` is how an extension chooses a fallback; it must not be hopeful. */
  it('answers canAccess false', () => {
    expect(shim.environment.canAccess(shim.OAuth)).toBe(false)
  })

  /**
   * Declined is not a platform limitation, and must never be filed as one — that
   * registry is a claim about what Linux can do.
   */
  it('does not blame Linux for a decision', () => {
    expect(unsupportedApis().map((entry) => entry.api)).not.toContain('OAuth')
  })
})

describe('the deprecated surface', () => {
  /**
   * A CommonJS bundle destructures the whole namespace at load, so one missing
   * export takes an extension down before any of it runs. That is why this is a
   * presence test and not a behaviour test — presence is the failure mode.
   */
  it('exports every alias the checklist names', () => {
    const required = [
      'CopyToClipboardAction',
      'OpenAction',
      'OpenInBrowserAction',
      'OpenWithAction',
      'PasteAction',
      'PushAction',
      'ShowInFinderAction',
      'SubmitFormAction',
      'TrashAction',
      'ActionPanelItem',
      'ActionPanelSection',
      'ActionPanelSubmenu',
      'ListItem',
      'ListSection',
      'FormTextField',
      'FormTextArea',
      'FormCheckbox',
      'FormDropdown',
      'FormDropdownItem',
      'FormDropdownSection',
      'FormTagPicker',
      'FormTagPickerItem',
      'FormDatePicker',
      'FormSeparator',
      'getLocalStorageItem',
      'setLocalStorageItem',
      'removeLocalStorageItem',
      'allLocalStorageItems',
      'clearLocalStorage',
      'copyTextToClipboard',
      'pasteText',
      'clearClipboard',
      'ToastStyle',
      'ImageMask',
      'showInFinder',
      'trash',
      'randomId',
      'useId',
      'useActionPanel',
      'preferences',
      'specialKeys',
      'unstable_AI',
      'useUnstableAI',
      'render'
    ] as const

    const missing = required.filter((name) => (shim as Record<string, unknown>)[name] === undefined)
    expect(missing).toEqual([])
  })

  it('gives ToastStyle the spec’s values, which extensions compare against', () => {
    expect(shim.ToastStyle.Success).toBe('SUCCESS')
    expect(shim.ToastStyle.Failure).toBe('FAILURE')
    expect(shim.ToastStyle.Animated).toBe('ANIMATED')
  })

  it('keeps Color’s values verbatim, because extensions persist them', () => {
    expect(shim.Color.Red).toBe('raycast-red')
    expect(shim.Color.PrimaryText).toBe('raycast-primary-text')
  })

  it('exposes Keyboard.Shortcut.Common, which is a value expression in real code', () => {
    expect(shim.Keyboard.Shortcut.Common.New).toBeDefined()
    expect(shim.Keyboard.Shortcut.Common.Copy).toBeDefined()
  })
})
