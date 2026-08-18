import type {
  ActionPanel as SpecActionPanel,
  Detail as SpecDetail,
  Form as SpecForm,
  Grid as SpecGrid,
  List as SpecList,
  MenuBarExtra as SpecMenuBarExtra
} from '@raycast/api'
import { Action } from './actions'
import { hostComponent, withMembers } from './elements'
import { DatePickerType, GridFit, GridInset, GridItemSize } from './enums'
import { markPending } from './unsupported'

/**
 * The components, as host elements.
 *
 * Every one of these is a name and a props type — the behaviour is in the
 * renderer, because that is where the pixels are. What this file has to get
 * right is the *shape*: which components exist, what they are called on the
 * wire, and which namespace members hang off which component. Getting that wrong
 * is how an extension renders a blank row instead of a list.
 *
 * Props types come from `@raycast/api` itself (see the path mapping in
 * `tsconfig.node.json`). Nothing here is written from memory.
 *
 * The wire type is the **dotted name** — `List.Item.Detail.Metadata.Label` — so a
 * render tree can be read by a person, and an unknown component names itself in
 * the renderer's "unsupported" card rather than arriving as an opaque number.
 */

// --- List --------------------------------------------------------------------

const ListDropdownItem = hostComponent<SpecList.Dropdown.Item.Props>('List.Dropdown.Item')
const ListDropdownSection = hostComponent<SpecList.Dropdown.Section.Props>('List.Dropdown.Section')
const ListDropdown = withMembers(hostComponent<SpecList.Dropdown.Props>('List.Dropdown'), {
  Item: ListDropdownItem,
  Section: ListDropdownSection
})

const MetadataLabel = hostComponent<SpecDetail.Metadata.Label.Props>('Detail.Metadata.Label')
const MetadataLink = hostComponent<SpecDetail.Metadata.Link.Props>('Detail.Metadata.Link')
const MetadataSeparator = hostComponent<SpecDetail.Metadata.Separator.Props>(
  'Detail.Metadata.Separator'
)
const MetadataTagListItem = hostComponent<SpecDetail.Metadata.TagList.Item.Props>(
  'Detail.Metadata.TagList.Item'
)
const MetadataTagList = withMembers(
  hostComponent<SpecDetail.Metadata.TagList.Props>('Detail.Metadata.TagList'),
  { Item: MetadataTagListItem }
)

/**
 * `Detail.Metadata` is shared by `Detail` and `List.Item.Detail`.
 *
 * One component object, referenced from both namespaces, because it is one thing
 * in the spec too — `List.Item.Detail.Metadata.Props` and `Detail.Metadata.Props`
 * are the same type. A second copy under a second wire name would render
 * identically until the day it did not.
 */
const Metadata = withMembers(hostComponent<SpecDetail.Metadata.Props>('Detail.Metadata'), {
  Label: MetadataLabel,
  Link: MetadataLink,
  Separator: MetadataSeparator,
  TagList: MetadataTagList
})

const ListItemDetail = withMembers(hostComponent<SpecList.Item.Detail.Props>('List.Item.Detail'), {
  Metadata
})

const ListItem = withMembers(hostComponent<SpecList.Item.Props>('List.Item'), {
  Detail: ListItemDetail
})

const ListSection = hostComponent<SpecList.Section.Props>('List.Section')
const ListEmptyView = hostComponent<SpecList.EmptyView.Props>('List.EmptyView')

export const List = withMembers(hostComponent<SpecList.Props>('List'), {
  Item: ListItem,
  Section: ListSection,
  EmptyView: ListEmptyView,
  Dropdown: ListDropdown
})

// --- Detail ------------------------------------------------------------------

export const Detail = withMembers(hostComponent<SpecDetail.Props>('Detail'), { Metadata })

// --- Grid --------------------------------------------------------------------

const GridDropdownItem = hostComponent<SpecGrid.Dropdown.Item.Props>('Grid.Dropdown.Item')
const GridDropdownSection = hostComponent<SpecGrid.Dropdown.Section.Props>('Grid.Dropdown.Section')
const GridDropdown = withMembers(hostComponent<SpecGrid.Dropdown.Props>('Grid.Dropdown'), {
  Item: GridDropdownItem,
  Section: GridDropdownSection
})

/**
 * `Grid` exists as an element and reaches the renderer, which has no case for it
 * and draws the "not supported yet" card. So it is marked pending: nothing about
 * the shim can tell you that, and a coverage number that counts it as built is
 * counting a name.
 *
 * Deferred out of M5 deliberately — Grid is List with bigger pictures, and the
 * first thing that genuinely wants it is M7's emoji picker. Building it there,
 * against a real consumer, beats guessing at column and inset behaviour now.
 */
export const Grid = markPending(withMembers(hostComponent<SpecGrid.Props>('Grid'), {
  Item: hostComponent<SpecGrid.Item.Props>('Grid.Item'),
  Section: hostComponent<SpecGrid.Section.Props>('Grid.Section'),
  EmptyView: hostComponent<SpecGrid.EmptyView.Props>('Grid.EmptyView'),
  Dropdown: GridDropdown,
  Inset: GridInset,
  Fit: GridFit,
  ItemSize: GridItemSize
}), 'the renderer draws no Grid; use a List with icons')

// --- Form --------------------------------------------------------------------

const FormDropdownItem = hostComponent<SpecForm.Dropdown.Item.Props>('Form.Dropdown.Item')
const FormDropdownSection = hostComponent<SpecForm.Dropdown.Section.Props>('Form.Dropdown.Section')
const FormDropdown = withMembers(hostComponent<SpecForm.Dropdown.Props>('Form.Dropdown'), {
  Item: FormDropdownItem,
  Section: FormDropdownSection
})

const FormTagPickerItem = hostComponent<SpecForm.TagPicker.Item.Props>('Form.TagPicker.Item')
const FormTagPicker = withMembers(hostComponent<SpecForm.TagPicker.Props>('Form.TagPicker'), {
  Item: FormTagPickerItem
})

const FormDatePicker = withMembers(hostComponent<SpecForm.DatePicker.Props>('Form.DatePicker'), {
  Type: DatePickerType,
  isFullDay: (date: Date | null | undefined): boolean =>
    date instanceof Date &&
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0
})

export const Form = withMembers(hostComponent<SpecForm.Props>('Form'), {
  TextField: hostComponent<SpecForm.TextField.Props>('Form.TextField'),
  TextArea: hostComponent<SpecForm.TextArea.Props>('Form.TextArea'),
  PasswordField: hostComponent<SpecForm.PasswordField.Props>('Form.PasswordField'),
  Checkbox: hostComponent<SpecForm.Checkbox.Props>('Form.Checkbox'),
  Dropdown: FormDropdown,
  TagPicker: FormTagPicker,
  DatePicker: FormDatePicker,
  FilePicker: hostComponent<SpecForm.FilePicker.Props>('Form.FilePicker'),
  Description: hostComponent<SpecForm.Description.Props>('Form.Description'),
  Separator: hostComponent<SpecForm.Separator.Props>('Form.Separator'),
  LinkAccessory: hostComponent<SpecForm.LinkAccessory.Props>('Form.LinkAccessory'),
  // The spec's `DeprecatedFormMembers`, for the same reason `ActionPanel.Item`
  // is above: a member that is missing is `undefined` in a JSX position, which
  // React reports as "element type is invalid" from somewhere else entirely.
  DropdownSection: FormDropdown.Section,
  DropdownItem: FormDropdown.Item,
  TagPickerItem: FormTagPicker.Item
})

// --- ActionPanel -------------------------------------------------------------

export const ActionPanel = withMembers(hostComponent<SpecActionPanel.Props>('ActionPanel'), {
  Section: hostComponent<SpecActionPanel.Section.Props>('ActionPanel.Section'),
  Submenu: hostComponent<SpecActionPanel.Submenu.Props>('ActionPanel.Submenu'),
  /**
   * `ActionPanel.Item` — the pre-`Action` name for an action, and the spec's
   * `DeprecatedActionPanelMembers`.
   *
   * Found by running `markdown-reference`, which uses it and did nothing but
   * fail with "Element type is invalid … got: undefined". The top-level alias
   * `ActionPanelItem` was already exported; this member was not, and the M4
   * coverage number could not see the difference because it counted **top-level**
   * exports. A deprecated member of a live component is invisible to that count
   * and just as load-bearing — see RAYCAST-COMPAT §Wave 1.5.
   */
  Item: Action
})

// --- MenuBarExtra ------------------------------------------------------------

/**
 * `MenuBarExtra` exists so importing it is not a crash. What it *does* is M8's
 * tray/waybar mapping (PLATFORM-MATRIX §11); until then the renderer draws an
 * explicit card rather than nothing, because a menu-bar command that silently
 * renders empty looks like our bug and is a missing feature.
 */
export const MenuBarExtra = withMembers(hostComponent<SpecMenuBarExtra.Props>('MenuBarExtra'), {
  Item: hostComponent<SpecMenuBarExtra.Item.Props>('MenuBarExtra.Item'),
  Section: hostComponent<SpecMenuBarExtra.Section.Props>('MenuBarExtra.Section'),
  // `MenuBarExtra.Separator` is a runtime member with no `Props` namespace in the
  // spec — its props interface is declared but not exported, and it is empty.
  Separator: hostComponent<Record<string, never>>('MenuBarExtra.Separator'),
  Submenu: hostComponent<SpecMenuBarExtra.Submenu.Props>('MenuBarExtra.Submenu')
})
