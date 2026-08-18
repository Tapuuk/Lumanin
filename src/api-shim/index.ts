import type { ReactNode } from 'react'
import { Action, CONVENIENCE_ACTIONS } from './actions'
import { ActionPanel, Detail, Form, Grid, List, MenuBarExtra } from './components'
import { Alert, Toast, confirmAlert, showHUD, showToast } from './feedback'
import {
  AlertActionStyle,
  Color,
  ImageMask,
  Keyboard,
  LaunchType,
  PopToRootType,
  ToastStyle,
  specialKeys
} from './enums'
import { Icon } from './icon'
import { AI } from './ai'
import { BrowserExtension, Image, OAuth, Tool, WindowManagement, launchCommand } from './namespaces'
import { CommandRoot, popNavigation, useNavigation } from './navigation'
import { requireRuntime } from './runtime'
import { unsupportedApis } from './unsupported'
import {
  Cache,
  Clipboard,
  LocalStorage,
  captureException,
  clearSearchBar,
  closeMainWindow,
  environment,
  getApplications,
  getDefaultApplication,
  getFrontmostApplication,
  getPreferenceValues,
  getSelectedFinderItems,
  getSelectedText,
  open,
  openCommandPreferences,
  openExtensionPreferences,
  popToRoot,
  preferences,
  showInFinder,
  trash,
  updateCommandMetadata
} from './system'

/**
 * `@raycast/api`, as an extension sees it.
 *
 * This module *is* the package: the worker's resolution hook points every
 * `import … from "@raycast/api"` here, so what is exported below is the entire
 * surface an extension can reach. An export that is missing does not fail
 * gracefully — a CommonJS bundle destructures the whole namespace at load, so one
 * absent name takes the extension down before any of it runs. That is why the
 * deprecated third of the spec is not optional and why
 * things we cannot do are exported as members that throw rather than left out.
 */

export {
  // Components
  Action,
  ActionPanel,
  Detail,
  Form,
  Grid,
  List,
  MenuBarExtra,
  // Feedback
  Alert,
  Toast,
  confirmAlert,
  showHUD,
  showToast,
  // Enumerations and value namespaces
  AI,
  BrowserExtension,
  Color,
  Icon,
  Image,
  Keyboard,
  LaunchType,
  OAuth,
  PopToRootType,
  Tool,
  WindowManagement,
  // Navigation
  useNavigation,
  // System
  Cache,
  Clipboard,
  LocalStorage,
  captureException,
  clearSearchBar,
  closeMainWindow,
  environment,
  getApplications,
  getDefaultApplication,
  getFrontmostApplication,
  getPreferenceValues,
  getSelectedFinderItems,
  getSelectedText,
  launchCommand,
  open,
  openCommandPreferences,
  openExtensionPreferences,
  popToRoot,
  showInFinder,
  trash,
  updateCommandMetadata
}

// ---------------------------------------------------------------------------
// The deprecated surface.
//
// 189 of the spec's exports are `@deprecated` and every one of them still works
// in Raycast, so a large share of the older store depends on them. They are all
// thin aliases; the expensive part is not writing them, it is discovering six
// months from now that a trivial extension fails to load because one is missing.
//
// **No runtime deprecation warning.** It is not the user's code and there is
// nothing they can do about it. `lumanin plugin-install` may note "uses legacy API";
// the running extension says nothing.
// ---------------------------------------------------------------------------

/** Action aliases. */
export const CopyToClipboardAction = CONVENIENCE_ACTIONS.CopyToClipboard
export const OpenAction = CONVENIENCE_ACTIONS.Open
export const OpenInBrowserAction = CONVENIENCE_ACTIONS.OpenInBrowser
export const OpenWithAction = CONVENIENCE_ACTIONS.OpenWith
export const PasteAction = CONVENIENCE_ACTIONS.Paste
export const PushAction = CONVENIENCE_ACTIONS.Push
export const ShowInFinderAction = CONVENIENCE_ACTIONS.ShowInFinder
export const SubmitFormAction = CONVENIENCE_ACTIONS.SubmitForm
export const TrashAction = CONVENIENCE_ACTIONS.Trash

/** ActionPanel aliases. `ActionPanel.Item` is the pre-`Action` name for an action. */
export const ActionPanelItem = Action
export const ActionPanelSection = ActionPanel.Section
export const ActionPanelSubmenu = ActionPanel.Submenu

/** List aliases. */
export const ListItem = List.Item
export const ListSection = List.Section

/** Form aliases. */
export const FormTextField = Form.TextField
export const FormTextArea = Form.TextArea
export const FormCheckbox = Form.Checkbox
export const FormDropdown = Form.Dropdown
export const FormDropdownItem = Form.Dropdown.Item
export const FormDropdownSection = Form.Dropdown.Section
export const FormTagPicker = Form.TagPicker
export const FormTagPickerItem = Form.TagPicker.Item
export const FormDatePicker = Form.DatePicker
export const FormSeparator = Form.Separator

/** LocalStorage function aliases. */
export const getLocalStorageItem = LocalStorage.getItem
export const setLocalStorageItem = LocalStorage.setItem
export const removeLocalStorageItem = LocalStorage.removeItem
export const allLocalStorageItems = LocalStorage.allItems
export const clearLocalStorage = LocalStorage.clear

/** Clipboard function aliases. */
export const copyTextToClipboard = Clipboard.copy
export const pasteText = Clipboard.paste
export const clearClipboard = Clipboard.clear

/** Miscellaneous aliases. */
export { AlertActionStyle, ImageMask, ToastStyle, preferences, specialKeys }
export const unstable_AI = AI
export const useUnstableAI = (): typeof AI => AI

/**
 * `randomId` — deprecated, typed `any` in the spec, and still used as a React
 * `key` generator by older extensions. `crypto.randomUUID` rather than a counter,
 * because a counter resets when a worker restarts and a stale key that collides
 * with a fresh one makes React reuse the wrong element.
 */
export function randomId(): string {
  return crypto.randomUUID()
}

/** `useId` — the same thing, shaped as a hook. Not React's `useId`. */
export function useId(): string {
  return randomId()
}

/**
 * `useActionPanel` — the pre-`actions`-prop way to set a view's action panel.
 *
 * There is nothing to hold: modern `<List actions={…}/>` puts the panel in the
 * tree, and this returns an `update` that does nothing so an extension calling it
 * neither crashes nor silently believes its actions were installed — it renders
 * with whatever its `actions` prop says, which for a legacy extension is nothing.
 * The alternative, a missing export, breaks the load.
 */
export function useActionPanel(): { update: (actionPanel: ReactNode) => void } {
  return { update: () => {} }
}

// ---------------------------------------------------------------------------
// `render()` — the pre-hooks entry point.
//
// Old extensions have no default export; they call `render(<Command/>)` at module
// scope. The worker loads the bundle and then asks for whatever was rendered, so
// this only has to remember it.
// ---------------------------------------------------------------------------

let legacyRoot: ReactNode = null

export function render(element: ReactNode): void {
  legacyRoot = element
  requireRuntime().scheduleRender()
}

// ---------------------------------------------------------------------------
// Internals, for the worker. Not part of `@raycast/api` and not something an
// extension has any reason to import — the `__lumanin` prefix is there so that
// one turning up in a bundle is visible as what it is.
// ---------------------------------------------------------------------------

export const __lumaninInternals = {
  CommandRoot,
  popNavigation,
  unsupportedApis,
  legacyRoot: (): ReactNode => legacyRoot
} as const

export { installRuntime as __lumaninInstallRuntime } from './runtime'
export type { ShimRuntime as __LumaninShimRuntime } from './runtime'
