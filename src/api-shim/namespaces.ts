import type { BrowserExtension as SpecBrowserExtension, WindowManagement as SpecWindowManagement } from '@raycast/api'
import { ImageMask } from './enums'
import { APP_METHODS } from '../shared/ext-protocol'
import { requireRuntime } from './runtime'
import { declined, markDeclined, markUnsupported, unsupported } from './unsupported'

/**
 * The remaining namespaces: the ones that are types with a value or two, and the
 * ones we cannot honour.
 *
 * Each is here rather than absent because **an import that throws is worse than
 * a member that throws**: a bundle is loaded in one go, so a missing export takes
 * the whole extension down at load time with a message about `undefined`, before
 * any of the parts that *do* work have had a chance to run.
 */

/** `Image` — types, plus `Image.Mask`. */
export const Image = { Mask: ImageMask } as const

/** `FileIcon` is a type only; nothing to export at runtime. */

/**
 * `BrowserExtension` ⛔.
 *
 * Needs a companion browser extension we do not ship. RAYCAST-COMPAT is explicit
 * that this must throw rather than return `[]`: an empty tab list reads as "no
 * tabs are open", and an extension told that will go on to do something wrong
 * with complete confidence.
 */
export const BrowserExtension = markUnsupported(
  'BrowserExtension',
  'it requires a companion browser extension, which Lumanin does not ship.',
  {
    getContent: unsupported<typeof SpecBrowserExtension.getContent>(
      'BrowserExtension.getContent',
      'it requires a companion browser extension, which Lumanin does not ship.'
    ),
    getTabs: unsupported<typeof SpecBrowserExtension.getTabs>(
      'BrowserExtension.getTabs',
      'it requires a companion browser extension, which Lumanin does not ship.'
    )
  }
)

/**
 * `WindowManagement` — cut, not impossible.
 *
 * The `windows` capability can list and focus windows on Hyprland, Sway and X11
 * (PLATFORM-MATRIX §7), so Linux could carry this API — but driving other apps'
 * windows is a window manager's job, not a launcher's, and the feature was cut
 * with the rest of the plugin-author sugar when the ship plan was drawn. It is
 * `declined` so the message says "we chose not to", not "Linux cannot".
 */
const NO_WINDOW_MANAGEMENT =
  'managing other windows is your window manager’s job; Lumanin does not drive it'
export const WindowManagement = {
  getDesktops: declined<typeof SpecWindowManagement.getDesktops>(
    'WindowManagement.getDesktops',
    NO_WINDOW_MANAGEMENT
  ),
  getActiveWindow: declined<typeof SpecWindowManagement.getActiveWindow>(
    'WindowManagement.getActiveWindow',
    NO_WINDOW_MANAGEMENT
  ),
  getWindowsOnActiveDesktop: declined<typeof SpecWindowManagement.getWindowsOnActiveDesktop>(
    'WindowManagement.getWindowsOnActiveDesktop',
    NO_WINDOW_MANAGEMENT
  ),
  setWindowBounds: declined<typeof SpecWindowManagement.setWindowBounds>(
    'WindowManagement.setWindowBounds',
    NO_WINDOW_MANAGEMENT
  ),
  DesktopType: { User: 'User', FullScreen: 'FullScreen' } as const
}

/**
 * Why there is no OAuth here, in the one sentence a plugin author needs.
 *
 * Shared by all four of the sign-in exports, because they are one decision.
 */
export const NO_OAUTH =
  'Lumanin runs no online services and does not broker sign-in. If this plugin needs a token, ' +
  'declare a preference of type "password" in its manifest and read it with getPreferenceValues() ' +
  ' - the user pastes one in `lumanin plugins`, and it never leaves their machine.'

/**
 * `OAuth` — the namespace, with a client that will not be built.
 *
 * **Declined, not pending** (user decision, 2026-08-10: zero online services,
 * fully local). PKCE is not hard and Linux does it fine; the objection is what
 * it drags in. A redirect flow means a loopback HTTP server inside the daemon, a
 * browser handing a code back to it, a token exchange against somebody else's
 * authorization server, refresh timers, and a store of live credentials that has
 * to be defended. All of that so a plugin can avoid asking for an API key —
 * which the preferences system already does, locally, today.
 *
 * Throwing in the constructor rather than at `authorize()` is still deliberate:
 * an extension builds its `PKCEClient` at module scope, so this fails at load
 * with a message naming OAuth and naming the alternative, instead of failing
 * three screens later when the user presses "Sign in".
 */
class DeclinedPKCEClient {
  constructor() {
    throw new Error(`OAuth.PKCEClient is not available in Lumanin: ${NO_OAUTH}`)
  }
}

export const OAuth = markDeclined(
  {
    PKCEClient: markDeclined(DeclinedPKCEClient, NO_OAUTH),
    RedirectMethod: { Web: 'web', App: 'app', AppURI: 'appURI' } as const
  },
  NO_OAUTH
)

/**
 * `Tool` — AI Extensions.
 *
 * `Tool.Confirmation<T>` is a *type*, so the namespace has no runtime members at
 * all. It is exported anyway because `import { Tool } from "@raycast/api"` in a
 * tool entry file must resolve, and RAYCAST-COMPAT is clear that the manifest and
 * install path have to parse `tools[]` even while the AI side is inert.
 */
export const Tool = {} as const

/**
 * `launchCommand(options)` — one command handing off to another.
 *
 * Two shapes, and the difference is only which extension is meant: `{name}`
 * alone is a sibling command in this extension, `{ownerOrAuthorName,
 * extensionName, name}` is somebody else's. `context` becomes the target's
 * `LaunchProps.launchContext` — the same field a pinned category arrives in, so
 * a command written to be launched from a pin is already written to be launched
 * from here.
 *
 * `LaunchType.Background` runs it with no window: the machinery is the one the
 * headless action target already uses. Anything else opens the panel on it.
 */
export async function launchCommand(options: {
  name: string
  type?: string
  ownerOrAuthorName?: string | null
  extensionName?: string | null
  arguments?: Readonly<Record<string, unknown>> | null
  context?: Readonly<Record<string, unknown>> | null
  fallbackText?: string | null
}): Promise<void> {
  await requireRuntime().call(APP_METHODS.LAUNCH_COMMAND, {
    name: options.name,
    background: options.type === 'background',
    ...(options.extensionName == null ? {} : { extensionName: options.extensionName }),
    ...(options.ownerOrAuthorName == null ? {} : { owner: options.ownerOrAuthorName }),
    ...(options.arguments == null ? {} : { launchArguments: options.arguments }),
    ...(options.context == null ? {} : { context: options.context }),
    ...(options.fallbackText == null ? {} : { fallbackText: options.fallbackText })
  })
}

/** `MCPServer` and friends are types; `Action.InstallMCPServer` carries the runtime refusal. */
