import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { filterRows } from '@shared/list-filter'
import { matchesShortcut } from '@shared/shortcut'
import { keyActionFor, type KeyMap } from '@shared/keys'
import { moveSelection } from '@shared/selection'
import { createSearchDispatch, type SearchDispatch } from '@shared/search-throttle'
import { SearchBar } from '../components/SearchBar'
import { ActionOverlay, ActionBar } from './ActionPanel'
import { readActionPanel, type ActionEntry, type ActionSet } from './actions'
import { Dropdown } from './Dropdown'
import { FormBody, readForm, useFormState, type FormModel } from './Form'
import { ExtIcon, IconImage, assetUrl, colorToken, resolveIcon } from './icons'
import { Markdown } from './markdown'
import type { SessionState } from './useSession'
import {
  activeView,
  arrayProp,
  bool,
  dateText,
  elementChildren,
  handler,
  navigationDepth,
  objectProp,
  slot,
  str,
  textOf,
  type RenderNode
} from './tree'

/**
 * The panel, while an extension is showing.
 *
 * The renderer is still dumb here: it plays
 * the tree the worker sent and forwards what the user did to it. It makes exactly
 * two decisions on its own, and both are ones Raycast's own renderer makes:
 * **which items a `<List filtering>` shows**, and **which item is selected**.
 * Both have to be local or every keystroke would be a round trip through two
 * process boundaries before anything moved.
 */

/**
 * Stands in when the view is not a form.
 *
 * `useFormState` is a hook, so it has to be called on every render whether there
 * is a form on screen or not. A shared frozen empty model keeps that call
 * honest — the state it derives is empty, and no field can be found in it.
 */
const EMPTY_FORM: FormModel = Object.freeze({
  fields: Object.freeze([]),
  isLoading: false,
  enableDrafts: false
})

/**
 * Stands in for the rows of a view that is not a list.
 *
 * One frozen array rather than a fresh `[]` per render: the rows are a
 * dependency of the effects below, and a new empty array every time would run
 * them on every render of a form or a detail.
 */
const EMPTY_ROWS: readonly Row[] = Object.freeze([])

interface ExtensionViewProps {
  readonly state: SessionState
  readonly focusToken: number
  /** The panel's own keys (`[keys]`), passed down rather than re-fetched here. */
  readonly keys: KeyMap
  /** Esc at the extension's root, or a dismissed error card. */
  readonly onExit: () => void
}

export function ExtensionView({ state, focusToken, keys, onExit }: ExtensionViewProps): React.JSX.Element {
  const { session, tree, searchText, setSearchText, requestedItem, clearRequestedItem } = state
  const extension = session?.extensionName ?? ''

  const view = activeView(tree)
  const depth = navigationDepth(tree)
  const isForm = view?.type === 'Form'

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  const send = useCallback(
    (handlerId: string | null, payload?: unknown) => {
      if (handlerId === null || session === null) return
      void window.lumanin.invoke('ext.event', {
        sessionId: session.sessionId,
        handlerId,
        ...(payload === undefined ? {} : { payload })
      })
    },
    [session]
  )

  // A pushed view is a different screen: keeping the old screen's selection
  // would put the cursor on row 7 of a list the user has not seen.
  useEffect(() => {
    setSelectedId(null)
    setPanelOpen(false)
  }, [depth])

  /**
   * Editing the query selects the top row.
   *
   * The same rule the root list follows, and for a related reason. Selecting by
   * id means a surviving row keeps the cursor — so filtering to "berry" and
   * clearing again left the highlight on the second row, three rows into a list
   * the user had just re-opened. Raycast resets too, and the top of a
   * freshly-filtered list is the only position that is right regardless of what
   * the filter did.
   *
   * This is the only thing that moves the cursor for a changed query, and a null
   * selection already *means* the top row wherever one is derived. So nothing
   * writes the derived id back into this state: doing that was a second render
   * per keystroke, spent reconciling the same rows again to reach a selection the
   * list had already settled on.
   */
  useEffect(() => {
    setSelectedId(null)
  }, [searchText])

  // Reading the tree and narrowing it are separate steps because they change for
  // separate reasons: a keystroke leaves the tree alone, and a patch from the
  // extension leaves the query alone. Splitting them means typing re-runs the
  // filter over rows that are still the objects they were, which is what lets the
  // rows below skip their own render.
  const shape = useMemo(() => (view?.type === 'List' ? readListShape(view) : null), [view])
  const visible = useMemo(
    () => (shape === null ? EMPTY_ROWS : filterRows(shape.rows, searchText, shape.filtered)),
    [shape, searchText]
  )
  const list = useMemo(
    () => (shape === null ? null : { ...shape, rows: visible }),
    [shape, visible]
  )
  const form = useMemo(() => (isForm && view !== null ? readForm(view) : null), [isForm, view])
  const formState = useFormState(form ?? EMPTY_FORM, send, state.fieldCommand)

  // Selection is by *id*, not index: the list re-sorts and re-filters under the
  // cursor constantly, and an index would silently change which row Enter runs.
  const rows = list?.rows ?? EMPTY_ROWS
  const selectedIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === selectedId)
  )
  const selected = rows[selectedIndex] ?? rows[0] ?? null

  /**
   * A requested landing spot — a pinned item, or `selectItemWithId` from the
   * extension. Applied the moment a row with that `id` prop exists, then
   * consumed; if the user moves the cursor first, the arrow handler drops it,
   * because "go here" must never fight the person holding the keys.
   */
  useEffect(() => {
    if (requestedItem === null) return
    const target = rows.find((row) => row.itemId === requestedItem)
    if (target === undefined) return
    setSelectedId(target.id)
    clearRequestedItem()
  }, [requestedItem, rows, clearRequestedItem])

  // `onSelectionChange` fires with the item's own `id` prop when it has one —
  // that is the identifier the extension gave it and the only one it can act on.
  const selectionHandler = list?.onSelectionChange ?? null
  const selectedKey = selected?.itemId ?? null
  useEffect(() => {
    if (selectionHandler !== null) send(selectionHandler, selectedKey)
  }, [selectionHandler, selectedKey, send])

  /**
   * Which actions are live.
   *
   * The selected item's, if it has any; the empty view's while it is what is on
   * screen; otherwise the view's own. That precedence is the spec's and it is
   * what makes a list with one shared action panel work alongside a list where
   * every row has its own.
   */
  const actions: ActionSet = useMemo(() => {
    if (selected?.actions != null) return readActionPanel(selected.actions)
    if (list !== null && list.rows.length === 0 && list.emptyView !== null) {
      const own = slot(list.emptyView, 'actions')
      if (own !== null) return readActionPanel(own)
    }
    if (view !== null) return readActionPanel(slot(view, 'actions'))
    return readActionPanel(null)
  }, [list, selected, view])

  const run = useCallback(
    (action: ActionEntry) => {
      setPanelOpen(false)
      // A submit carries the form's values. With no form on screen it carries an
      // empty object, which is what `Action.SubmitForm` documents as "there was
      // nothing to submit" — not `undefined`, which would reach `onSubmit` as a
      // missing argument and break destructuring in the extension.
      if (action.submitsForm) send(action.handlerId, formState.payload())
      else send(action.handlerId)
    },
    [send, formState]
  )

  // One dispatch for the life of the view, because a new one per render would
  // have no burst to collapse. It reaches `send` through a ref: `send` is rebuilt
  // whenever the session changes, and a dispatch built once would otherwise keep
  // posting into the session it was born in.
  const sender = useRef(send)
  sender.current = send
  const dispatch = useRef<SearchDispatch | null>(null)
  dispatch.current ??= createSearchDispatch((handlerId, text) => sender.current(handlerId, text))

  /**
   * A text still waiting to be sent belongs to the view that was on screen when
   * it was typed. Handler ids are per node, so a pushed view, a popped one and a
   * whole new session all change this — and delivering after any of them would
   * address a handler the worker has already dropped. Typing does not trigger it:
   * the handler id is the same string from one keystroke to the next.
   */
  useEffect(() => () => dispatch.current?.cancel(), [session?.sessionId, list?.onSearchTextChange])

  const onSearch = useCallback(
    (text: string) => {
      // Unconditional and first: the box and anything the panel filters itself
      // never wait on the extension.
      setSearchText(text)
      if (list?.onSearchTextChange != null) {
        dispatch.current?.send(list.onSearchTextChange, text, list.throttle)
      }
    },
    [list, setSearchText]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const key: Parameters<typeof matchesShortcut>[0] = {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey
      }

      const bound = keyActionFor(keys, key, { searchEmpty: searchText.length === 0 })

      if (bound === 'back') {
        event.preventDefault()
        if (panelOpen) setPanelOpen(false)
        else if (depth > 1 && session !== null) {
          void window.lumanin.invoke('ext.pop', { sessionId: session.sessionId })
        } else onExit()
        return
      }

      if (bound === 'actionPanel') {
        event.preventDefault()
        setPanelOpen((open) => !open)
        return
      }

      // While the overlay is open it owns the keyboard, apart from the two keys
      // handled above. Letting shortcuts through would run an action *and* leave
      // the overlay showing the list it was chosen from.
      if (panelOpen) return

      if (bound === 'next' || bound === 'previous') {
        event.preventDefault()
        clearRequestedItem()
        const step = bound === 'next' ? 1 : -1
        const next = rows[moveSelection(selectedIndex, step, rows.length)]
        if (next !== undefined) setSelectedId(next.id)
        return
      }

      if (bound === 'category') {
        // Tab by default. The dropdown owns its choices, so this only
        // broadcasts; a view without a dropdown swallows the key rather than
        // letting focus wander out of the search field.
        event.preventDefault()
        window.dispatchEvent(new Event('lumanin:cycle-category'))
        return
      }

      if (bound === 'open') {
        event.preventDefault()
        if (actions.primary !== null) run(actions.primary)
        return
      }

      if (bound === 'secondary') {
        event.preventDefault()
        // Falls back to the primary action rather than doing nothing: a row with
        // one action still has something to open, and a key that works on some
        // rows and not others is the kind of thing people stop trusting.
        const target = actions.secondary ?? actions.primary
        if (target !== null) run(target)
        return
      }

      // An extension's own shortcuts. Checked last so nothing an extension
      // declares can shadow Esc, Enter or the action panel — those three are the
      // panel's, and a launcher you cannot get out of is not one.
      for (const action of actions.flat) {
        if (action.shortcut === null) continue
        if (!matchesShortcut(key, action.shortcut)) continue
        event.preventDefault()
        run(action)
        return
      }
    },
    [actions, clearRequestedItem, depth, onExit, panelOpen, rows, run, selectedIndex, session]
  )

  /**
   * The same keys, for a view where focus is not in the search field.
   *
   * A form's controls own the arrows (they move the caret) and a text area owns
   * Enter (it makes a newline), so those two cases are handed back to the
   * browser. Everything else — Esc, the action panel, submit, an extension's own
   * shortcuts — has to keep working, and the derivation is deliberately the same
   * `actions` object, so what Enter does can never disagree with what the panel
   * says it does.
   */
  const onFormKeyDown = useCallback(
    (event: KeyboardEvent<Element>) => {
      const key: Parameters<typeof matchesShortcut>[0] = {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey
      }

      // A form has no search box, and every field is one — so a binding that is
      // also a character (a bare Space) must never act here, whatever the field
      // happens to contain. `searchEmpty: false` says exactly that.
      const bound = keyActionFor(keys, key, { searchEmpty: false })

      if (bound === 'back') {
        event.preventDefault()
        if (panelOpen) setPanelOpen(false)
        else if (depth > 1 && session !== null) {
          void window.lumanin.invoke('ext.pop', { sessionId: session.sessionId })
        } else onExit()
        return
      }

      if (bound === 'actionPanel') {
        event.preventDefault()
        setPanelOpen((open) => !open)
        return
      }
      if (panelOpen) return

      if (bound === 'open') {
        if (event.target instanceof HTMLTextAreaElement) return
        event.preventDefault()
        if (actions.primary !== null) run(actions.primary)
        return
      }

      if (bound === 'secondary') {
        event.preventDefault()
        const target = actions.secondary ?? actions.primary
        if (target !== null) run(target)
        return
      }

      for (const action of actions.flat) {
        if (action.shortcut === null) continue
        if (!matchesShortcut(key, action.shortcut)) continue
        event.preventDefault()
        run(action)
        return
      }
    },
    [actions, depth, onExit, panelOpen, run, session]
  )

  const placeholder = list?.placeholder ?? 'Search...'
  const accessory = view === null ? null : slot(view, 'searchBarAccessory')

  return (
    <>
      {isForm ? (
        // A form has no query to type, so the search field would be a text box
        // that does nothing while holding the focus every control on screen
        // needs. The navigation title takes its place.
        <div className="searchrow searchrow--title">
          <span className="ext-title">
            {(view === null ? null : str(view.props['navigationTitle'])) ??
              session?.commandTitle ??
              ''}
          </span>
        </div>
      ) : (
        <div className="searchrow">
          <SearchBar
            value={searchText}
            onChange={onSearch}
            onKeyDown={onKeyDown}
            focusToken={focusToken}
            placeholder={placeholder}
          />
          {accessory !== null && <Dropdown node={accessory} onEvent={send} />}
        </div>
      )}

      {state.failure !== null ? (
        <ErrorCard
          title={session?.commandTitle ?? 'This command'}
          failure={state.failure}
          onReload={() => {
            if (session !== null) void window.lumanin.invoke('ext.reload', { sessionId: session.sessionId })
          }}
        />
      ) : view === null ? (
        <Loading />
      ) : form !== null ? (
        <FormBody
          model={form}
          state={formState}
          sessionId={session?.sessionId ?? ''}
          onKeyDown={onFormKeyDown}
        />
      ) : (
        <Body view={view} list={list} selected={selected} extension={extension} send={send} />
      )}

      {state.toast !== null && (
        <div className={`toast toast--${state.toast.style.toLowerCase()}`} role="status">
          <span className="toast__title">{state.toast.title}</span>
          {state.toast.message !== undefined && (
            <span className="toast__message">{state.toast.message}</span>
          )}
          {state.toast.primaryAction !== undefined && (
            <button
              type="button"
              className="toast__action"
              onClick={() => send(state.toast?.primaryAction?.handlerId ?? null)}
            >
              {state.toast.primaryAction.title}
            </button>
          )}
        </div>
      )}

      <ActionBar
        actions={actions}
        depth={depth}
        keys={keys}
        searchEmpty={searchText.length === 0}
        onOpen={() => setPanelOpen(true)}
      />

      {panelOpen && (
        <ActionOverlay actions={actions} keys={keys} onRun={run} onClose={() => setPanelOpen(false)} />
      )}

      {state.alert !== null && <AlertDialog alert={state.alert} answer={state.answerAlert} />}
    </>
  )
}

// --- confirmAlert ------------------------------------------------------------

interface AlertDialogProps {
  readonly alert: NonNullable<SessionState['alert']>
  readonly answer: (confirmed: boolean) => void
}

/**
 * The `confirmAlert` dialog.
 *
 * A component rather than inline JSX for one reason: focus. It takes the
 * keyboard on mount — an alert you can dismiss without reaching for the mouse —
 * and gives it back on unmount, the same loan the action overlay makes. An
 * `autoFocus` attribute alone is the bug: it takes and never returns, and the
 * search input is the only element in the window that listens for keys, so a
 * plugin calling `confirmAlert` would leave the launcher keyboard-dead once the
 * dialog closed.
 */
function AlertDialog({ alert, answer }: AlertDialogProps): React.JSX.Element {
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement
    primary.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  return (
    <div className="alert" role="alertdialog" aria-label={alert.title}>
      <div className="alert__box">
        <div className="alert__title">{alert.title}</div>
        {alert.message !== undefined && <div className="alert__message">{alert.message}</div>}
        <div className="alert__buttons">
          <button type="button" onClick={() => answer(false)}>
            {alert.dismissTitle}
          </button>
          <button
            type="button"
            className={alert.destructive ? 'alert__primary alert__primary--destructive' : 'alert__primary'}
            ref={primary}
            onClick={() => answer(true)}
          >
            {alert.primaryTitle}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- the body ----------------------------------------------------------------

interface BodyProps {
  readonly view: RenderNode
  readonly list: ListModel | null
  readonly selected: Row | null
  readonly extension: string
  readonly send: (handlerId: string | null, payload?: unknown) => void
}

function Body({ view, list, selected, extension, send }: BodyProps): React.JSX.Element {
  switch (view.type) {
    case 'List':
      return (
        <ListBody list={list} selected={selected} extension={extension} send={send} />
      )
    case 'Detail':
      return <DetailBody node={view} extension={extension} />
    default:
      // An unknown type gets a visible card naming it, never a blank screen.
      // It is also how a half-implemented feature tells the truth
      // — `Form` and `Grid` land here today and say so.
      return (
        <div className="ext-unsupported" role="alert">
          <div className="ext-unsupported__title">{view.type} is not supported yet</div>
          <div className="ext-unsupported__detail">
            This command renders a <code>{view.type}</code>, which Lumanin does not draw in this
            version. Nothing is wrong with the extension.
          </div>
        </div>
      )
  }
}

function Loading(): React.JSX.Element {
  return (
    <div className="ext-loading" role="status">
      Starting…
    </div>
  )
}

interface ErrorCardProps {
  readonly title: string
  readonly failure: { message: string; stack: string | null }
  readonly onReload: () => void
}

function ErrorCard({ title, failure, onReload }: ErrorCardProps): React.JSX.Element {
  return (
    <div className="ext-error" role="alert">
      <div className="ext-error__title">{title} stopped</div>
      <div className="ext-error__message">{failure.message}</div>
      {failure.stack !== null && <pre className="ext-error__stack">{failure.stack}</pre>}
      <button type="button" className="ext-error__reload" onClick={onReload}>
        Reload
      </button>
    </div>
  )
}

// --- List --------------------------------------------------------------------

interface Row {
  /** The tree node id — stable, unique, and never the extension's to choose. */
  readonly id: string
  /** The extension's own `id` prop, which is what `onSelectionChange` reports. */
  readonly itemId: string | null
  readonly title: string
  readonly subtitle: string | null
  readonly icon: RenderNode['props'][string] | undefined
  readonly accessories: readonly Accessory[]
  readonly actions: RenderNode | null
  readonly detail: RenderNode | null
  readonly sectionTitle: string | null
  /** The item's `keywords`, joined — the only searchable text besides the title. */
  readonly keywords: string
}

interface Accessory {
  readonly text: string | null
  readonly tint: string | undefined
  /** An accessory may be an icon, a text, or both — all three are common. */
  readonly icon: RenderNode['props'][string] | undefined
}

interface ListModel {
  readonly rows: readonly Row[]
  readonly isLoading: boolean
  readonly showingDetail: boolean
  readonly placeholder: string
  readonly emptyView: RenderNode | null
  readonly onSearchTextChange: string | null
  readonly onSelectionChange: string | null
  readonly filtered: boolean
  readonly throttle: boolean
}

/**
 * Read a `<List>`: every row it holds, and what the view itself says.
 *
 * Whether those rows are then narrowed is decided by the spec: `<List>` filters
 * client-side unless the extension takes `onSearchTextChange`, in which case the
 * extension owns the query and filtering defaults **off** — filtering its results
 * again would hide rows it deliberately returned. That answer travels as
 * `filtered`, and `filterRows` applies it; *how* a query narrows a list is the
 * launcher's own search, documented there.
 *
 * `rows` here is every row in the tree. What the caller hands on as a
 * `ListModel` carries the visible ones, which is what every consumer means by
 * `rows`.
 */
function readListShape(node: RenderNode): ListModel {
  const onSearchTextChange = handler(node.props['onSearchTextChange'])
  const explicitFiltering = node.props['filtering']
  const filtering =
    typeof explicitFiltering === 'boolean'
      ? explicitFiltering
      : objectProp(explicitFiltering) !== null
        ? true
        : onSearchTextChange === null

  const rows: Row[] = []
  let emptyView: RenderNode | null = null

  const collect = (parent: RenderNode, sectionTitle: string | null): void => {
    for (const child of elementChildren(parent)) {
      switch (child.type) {
        case 'List.Section':
          collect(child, str(child.props['title']))
          break
        case 'List.Item':
          rows.push(readRow(child, sectionTitle))
          break
        case 'List.EmptyView':
          emptyView = child
          break
        default:
          break
      }
    }
  }
  collect(node, null)

  return {
    rows,
    isLoading: bool(node.props['isLoading']),
    showingDetail: bool(node.props['isShowingDetail']),
    placeholder: str(node.props['searchBarPlaceholder']) ?? 'Search...',
    emptyView,
    onSearchTextChange,
    onSelectionChange: handler(node.props['onSelectionChange']),
    filtered: filtering,
    throttle: bool(node.props['throttle'])
  }
}

/**
 * One `Row` per tree node, reused while the node is.
 *
 * A patch batch copies only the containers on the paths it names, so a node no
 * operation touched comes back as the very object it was — and a row is a pure
 * function of its node and the section it sits in. Rebuilding anyway would hand
 * every row below a new object, which is the one thing that stops a memoized row
 * from skipping its render when the extension re-renders for its own reasons.
 */
const rowCache = new WeakMap<RenderNode, { sectionTitle: string | null; row: Row }>()

function readRow(node: RenderNode, sectionTitle: string | null): Row {
  const cached = rowCache.get(node)
  if (cached !== undefined && cached.sectionTitle === sectionTitle) return cached.row

  const row = buildRow(node, sectionTitle)
  rowCache.set(node, { sectionTitle, row })
  return row
}

function buildRow(node: RenderNode, sectionTitle: string | null): Row {
  const title = str(node.props['title']) ?? textOf(node)
  const subtitle = str(node.props['subtitle'])
  const keywords = arrayProp(node.props['keywords'])
    .map((entry) => str(entry) ?? '')
    .join(' ')

  return {
    id: node.id,
    itemId: str(node.props['id']),
    title,
    subtitle,
    icon: node.props['icon'],
    accessories: arrayProp(node.props['accessories']).map(readAccessory),
    actions: slot(node, 'actions'),
    detail: slot(node, 'detail'),
    sectionTitle,
    keywords
  }
}

function readAccessory(value: unknown): Accessory {
  const object = objectProp(value as never)
  if (object === null) return { text: str(value as never), tint: undefined, icon: undefined }

  const tint = colorToken(str(object['color']) ?? tintOf(object['text']) ?? tintOf(object['tag']))
  const text =
    str(object['text']) ??
    str(object['tag']) ??
    dateText(object['date']) ??
    dateText(objectProp(object['tag'])?.['value']) ??
    null

  return { text, tint, icon: object['icon'] }
}

function tintOf(value: unknown): string | null {
  const object = objectProp(value as never)
  return object === null ? null : str(object['color'])
}

interface ListBodyProps {
  readonly list: ListModel | null
  readonly selected: Row | null
  readonly extension: string
  readonly send: (handlerId: string | null, payload?: unknown) => void
}

/**
 * DOM rows drawn at once. A plugin may hand over thousands of rows and rely on
 * filtering to narrow them; drawing them all makes every keystroke re-render
 * the lot. The window slides with the selection, so the keyboard can still
 * reach every row.
 */
const MAX_RENDERED_ROWS = 150

function ListBody({ list, selected, extension, send }: ListBodyProps): React.JSX.Element | null {
  const selectedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  if (list === null) return null

  if (list.rows.length === 0) {
    if (list.isLoading) return <div className="ext-loading">Loading…</div>
    if (list.emptyView === null) return null
    return (
      <div className="ext-empty">
        <div className="ext-empty__title">{str(list.emptyView.props['title']) ?? 'Nothing found'}</div>
        {str(list.emptyView.props['description']) !== null && (
          <div className="ext-empty__description">{str(list.emptyView.props['description'])}</div>
        )}
      </div>
    )
  }

  let start = 0
  if (list.rows.length > MAX_RENDERED_ROWS) {
    const selectedIndex = Math.max(
      0,
      list.rows.findIndex((row) => row.id === selected?.id)
    )
    start = Math.min(
      Math.max(0, selectedIndex - Math.floor(MAX_RENDERED_ROWS / 2)),
      list.rows.length - MAX_RENDERED_ROWS
    )
  }
  const windowed =
    list.rows.length > MAX_RENDERED_ROWS ? list.rows.slice(start, start + MAX_RENDERED_ROWS) : list.rows

  const items = (
    <div className="results" role="listbox" aria-label="Results">
      {windowed.map((row, offset) => {
        const index = start + offset
        const isSelected = row.id === selected?.id
        const showSection =
          row.sectionTitle !== null && row.sectionTitle !== list.rows[index - 1]?.sectionTitle

        return (
          <div key={row.id}>
            {showSection && <div className="results__section">{row.sectionTitle}</div>}
            <div
              ref={isSelected ? selectedRef : undefined}
              className="result"
              data-kind="extension"
              role="option"
              aria-selected={isSelected}
              onClick={() => send(readActionPanel(row.actions).primary?.handlerId ?? null)}
            >
              <ExtIcon icon={resolveIcon(row.icon, extension)} />
              <span className="result__text">
                <span className="result__title">{row.title}</span>
                {row.subtitle !== null && <span className="result__subtitle">{row.subtitle}</span>}
              </span>
              {row.accessories.map((accessory, accessoryIndex) => {
                const icon = resolveIcon(accessory.icon, extension)
                if (accessory.text === null && icon === null) return null
                return (
                  <span
                    className="result__accessory"
                    key={accessoryIndex}
                    style={accessory.tint === undefined ? undefined : { color: accessory.tint }}
                  >
                    {icon !== null && (
                      <span className="result__accessory-icon" aria-hidden="true">
                        {icon.src !== undefined ? (
                          <IconImage src={icon.src} tint={icon.tint} />
                        ) : (
                          icon.glyph
                        )}
                      </span>
                    )}
                    {accessory.text}
                  </span>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )

  if (!list.showingDetail || selected?.detail == null) return items

  // `isShowingDetail` splits the panel: the list narrows and the selected item's
  // detail pane fills the rest. Both scroll independently, which is what makes a
  // long document usable next to a long list.
  return (
    <div className="ext-split">
      <div className="ext-split__list">{items}</div>
      <div className="ext-split__detail">
        <DetailBody node={selected.detail} extension={extension} />
      </div>
    </div>
  )
}

// --- Detail ------------------------------------------------------------------

interface DetailBodyProps {
  readonly node: RenderNode
  readonly extension: string
}

function DetailBody({ node, extension }: DetailBodyProps): React.JSX.Element {
  const markdown = str(node.props['markdown']) ?? ''
  const metadata = slot(node, 'metadata')
  // Stable, so the document below is parsed once rather than on every render of
  // the list this pane sits beside.
  const resolveAsset = useCallback((path: string) => assetUrl(extension, path), [extension])

  return (
    <div className="ext-detail">
      {markdown.length > 0 && (
        <Markdown source={markdown} extension={extension} resolveAsset={resolveAsset} />
      )}
      {metadata !== null && <Metadata node={metadata} />}
      {bool(node.props['isLoading']) && <div className="ext-loading">Loading…</div>}
    </div>
  )
}

function Metadata({ node }: { readonly node: RenderNode }): React.JSX.Element {
  return (
    <div className="ext-metadata">
      {elementChildren(node).map((child) => {
        switch (child.type) {
          case 'Detail.Metadata.Separator':
            return <hr className="ext-metadata__separator" key={child.id} />
          case 'Detail.Metadata.Label':
            return (
              <div className="ext-metadata__row" key={child.id}>
                <span className="ext-metadata__label">{str(child.props['title'])}</span>
                <span
                  className="ext-metadata__value"
                  style={{ color: colorToken(tintOf(child.props['text'])) }}
                >
                  {str(child.props['text'])}
                </span>
              </div>
            )
          case 'Detail.Metadata.Link':
            return (
              <div className="ext-metadata__row" key={child.id}>
                <span className="ext-metadata__label">{str(child.props['title'])}</span>
                <button
                  type="button"
                  className="md__link"
                  onClick={() => {
                    const target = str(child.props['target'])
                    if (target !== null && /^https?:/i.test(target)) {
                      void window.lumanin.invoke('search.launch', { id: `web:${target}` })
                    }
                  }}
                >
                  {str(child.props['text']) ?? str(child.props['target'])}
                </button>
              </div>
            )
          case 'Detail.Metadata.TagList':
            return (
              <div className="ext-metadata__row" key={child.id}>
                <span className="ext-metadata__label">{str(child.props['title'])}</span>
                <span className="ext-metadata__tags">
                  {elementChildren(child).map((tag) => (
                    <span
                      className="ext-metadata__tag"
                      key={tag.id}
                      style={{ color: colorToken(str(tag.props['color'])) }}
                    >
                      {str(tag.props['text'])}
                    </span>
                  ))}
                </span>
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
