import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { ResultItem } from '@shared/ipc'
import { clampSelection, moveSelection } from '@shared/selection'
import { ResultList } from './components/ResultList'
import { SearchBar } from './components/SearchBar'
import { ExtensionView } from './ext/ExtensionView'
import { useKeys } from './useKeys'
import { keyActionFor } from '@shared/keys'
import { useSession } from './ext/useSession'
import { useSurfaceSize } from './useSurfaceSize'
import { useTheme } from './useTheme'

/**
 * The root view.
 *
 * The renderer is deliberately dumb (ARCHITECTURE.md §"Renderer ↔ main"): it
 * renders state and forwards intents. It never decides what Esc means, never
 * hides itself, never ranks anything, and never reads anything outside the
 * preload bridge.
 *
 * Shape: the window is a fixed box the size of the panel at its fullest, and the
 * panel occupies the top of it — a bare search bar until there is something to
 * show, then one row taller per result until it fills the box and the list
 * scrolls. The rest of the window is transparent.
 *
 * That is a deliberate inversion of the obvious design, where the window is
 * resized to fit the content. See ARCHITECTURE.md §"Panel sizing": the search
 * field must not move as results appear, and a compositor that keeps a floating
 * window's *centre* fixed when the client resizes itself — Hyprland does — moves
 * it by half the growth every time. Not resizing is the only version of "the bar
 * stays put" that does not depend on how the compositor anchors a resize.
 */
export function App(): React.JSX.Element {
  const theme = useTheme()
  const keys = useKeys()
  const [query, setQuery] = useState('')
  const [focusToken, setFocusToken] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [items, setItems] = useState<readonly ResultItem[]>([])
  const [error, setError] = useState<string | null>(null)

  /**
   * The extension session, if one is running.
   *
   * The panel has exactly two modes and this is the switch between them: at the
   * root it is the launcher, and while a session is live it is that extension's
   * window. Not a route and not a second component tree — the search field, the
   * theme and the panel chrome are the same ones either way, which is what makes
   * an extension feel like part of the launcher rather than a thing hosted in it.
   */
  const session = useSession()

  /**
   * Whether this session has a root list behind it.
   *
   * A command launched from a row here can go back to that row when it ends. A
   * command the *daemon* started — a key bound straight to it, which is the only
   * way into file search — has nothing behind it: the panel was opened to be
   * that view, and backing out of it into a launcher the user did not ask for is
   * the panel changing into a different application under them. So Escape at the
   * bottom of such a session closes the window.
   *
   * Told to us by whoever started it — `SessionInfo.standalone` — rather than
   * inferred here, with one rule for the middle case: `launchCommand` replaces
   * the session in place and says nothing, so it *keeps* the current answer. A
   * plugin opening another plugin does not change what is behind either of them.
   */
  const [standalone, setStandalone] = useState(false)


  // Nothing to show means nothing below the search bar — not an empty-state row,
  // not a footer. A query that matches nothing leaves the panel exactly as tall
  // as it was before you typed.
  const hasResults = items.length > 0

  useSurfaceSize()

  // Every result set is requested from main. Searching is not debounced: it is
  // in-memory scoring over a few thousand entries, and a debounce would add
  // latency to hide work that is already faster than the next keystroke.
  //
  // The generation counter is not optional even so — IPC replies can land out of
  // order, and a stale one overwriting a newer result set shows the user answers
  // to a query they have already moved past.
  const generation = useRef(0)
  useEffect(() => {
    const ours = ++generation.current
    void window.lumanin.invoke('search.query', { query }).then((results) => {
      if (generation.current === ours) setItems(results)
    })
  }, [query])

  useEffect(() => {
    return window.lumanin.on('window.visibility', ({ visible }) => {
      // Reset on **hide**, not on show. Clearing when the panel opens is one
      // frame too late: the window maps with last time's results still in the
      // DOM, so the panel appears at its old full height and collapses to a bare
      // search bar a frame later — the flash reported from a real session, and
      // reproducible every time by dismissing with a click instead of Escape.
      //
      // Resetting while hidden costs nothing: nobody is looking, and the layout
      // is already settled by the time it is shown.
      setQuery('')
      setItems([])
      setSelectedIndex(0)
      setError(null)
      // The daemon ends the session when the panel is dismissed; this drops the
      // renderer's half so the next open is the root list rather than the last
      // extension's final frame.
      if (!visible) {
        session.end()
        // The next session decides this for itself; leaving the last one's
        // answer behind would make a row-launched command close the window.
        //
        // On **hide** only, unlike everything above it. The daemon announces a
        // session and *then* shows the window, so clearing this on show would
        // wipe the flag `ext.started` had just set — which is exactly what it
        // did: a key-opened view whose Escape went to the root list, but only
        // when the panel had been closed beforehand.
        setStandalone(false)
      }
      // Focus still has to be taken on show — a hidden window cannot hold it.
      else setFocusToken((token) => token + 1)
    })
    // `session.end` is stable; the empty deps keep this subscription for the
    // panel's whole lifetime, which is the point — it must not resubscribe on
    // every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A session the daemon started on its own — `lumanin open` from a hotkey
  // bind. Adopted exactly as if this renderer had launched it.
  useEffect(() => {
    return window.lumanin.on('ext.started', (info) => {
      // The daemon says which kind this is; `launchCommand` says nothing and
      // keeps the answer, because it replaces a session rather than starting
      // one. See `SessionInfo.standalone`.
      setStandalone((current) => info.standalone ?? current)
      session.begin(info)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Editing the query builds a different list, so the old index now points at an
  // unrelated row. Keeping it would mean the row under the cursor silently
  // changed identity between the keystroke and Enter — the one mistake a
  // launcher must never make. Top of the list is the only safe answer.
  useEffect(() => {
    setSelectedIndex(0)
    setError(null)
  }, [query])

  // The source can also shrink on its own — a background re-index, a result that
  // disappeared — without the query changing.
  useEffect(() => {
    setSelectedIndex((index) => clampSelection(index, items.length))
  }, [items.length])

  const activate = useCallback(
    (item: ResultItem) => {
      // Main hides the panel on success; a failure keeps it open and says why,
      // because a launcher that vanishes without starting anything is indisting-
      // uishable from one that crashed.
      void window.lumanin.invoke('search.launch', { id: item.id }).then((outcome) => {
        if (!outcome.ok) {
          setError(outcome.detail)
          return
        }
        // An extension command is the one launch that does not close the panel:
        // the panel becomes the extension. Started from a row, so the root list
        // is what Escape comes back to.
        if (outcome.session !== undefined) {
          setStandalone(false)
          session.begin(outcome.session)
        }
      })
    },
    [session]
  )

  /**
   * Close the window from the bottom of a standalone session.
   *
   * The session is ended here rather than left for `window.visibility` to clear:
   * the hide is asynchronous, and a panel that stayed on the extension's last
   * frame for those few milliseconds is a panel that flickers on the way out.
   */
  const dismiss = useCallback(() => {
    session.end()
    void window.lumanin.invoke('window.hide')
  }, [session])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // `[keys]`, not constants: every one of these is rebindable, and the one
      // rule that comes with that is in `matchesKeyAction` — a binding with no
      // modifier and a one-character key is also typing, so it only acts while
      // the box is empty.
      const context = { searchEmpty: query.length === 0 }
      const action = keyActionFor(keys, event, context)

      if (action === 'next' || action === 'previous') {
        event.preventDefault()
        const step = action === 'next' ? 1 : -1
        setSelectedIndex((index) => moveSelection(index, step, items.length))
        return
      }

      // The root list has one action per row, so `secondary` does what `open`
      // does rather than nothing: a key the user bound should not be dead here
      // just because there is no second action to run.
      if (action === 'open' || action === 'secondary') {
        event.preventDefault()
        const item = items[selectedIndex]
        if (item !== undefined) activate(item)
        return
      }

      if (action !== 'back') return

      event.preventDefault()
      // Main owns the decision — it depends on `[general].esc_at_root`, and later
      // on whether an extension navigation stack is open. The renderer only
      // reports whether there is anything left to back out of.
      const atRoot = query.length === 0
      void window.lumanin.invoke('window.escape', { atRoot }).then(({ action }) => {
        if (action === 'clear') setQuery('')
      })
    },
    [items, selectedIndex, query, activate, keys]
  )

  /**
   * The transparent area below the panel still belongs to our window, so a click
   * there never blurs it and `hide_on_blur` never fires. Dismissing has to be
   * explicit, or the empty space would become the one place on screen where
   * clicking away does nothing.
   *
   * `mousedown` rather than `click`, and only when the press landed on the
   * backdrop itself: a press that starts inside the panel and drifts out while
   * selecting text must not close it.
   */
  const onBackdropMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    void window.lumanin.invoke('window.hide')
  }, [])

  // Rendering before the theme arrives would paint one frame of undefined
  // custom properties — invisible text, the failure mode THEMING.md calls out.
  if (theme === null) return <div className="root" />

  return (
    <div className="root" onMouseDown={onBackdropMouseDown}>
      <div className="panel">
        {session.session !== null ? (
          <ExtensionView
            state={session}
            focusToken={focusToken}
            keys={keys}
            onExit={standalone ? dismiss : session.end}
          />
        ) : (
          <>
            <SearchBar
              value={query}
              onChange={setQuery}
              onKeyDown={onKeyDown}
              focusToken={focusToken}
            />
            {hasResults && (
              <ResultList items={items} selectedIndex={selectedIndex} onActivate={activate} />
            )}
            {error !== null && (
              <div className="notice" role="alert">
                {error}
              </div>
            )}
          </>
        )}
      </div>
      {/* Outside the panel: `showHUD` closes the window and shows this over the
          desktop, so it must not be clipped by the panel's own box. */}
      {session.hud !== null && <div className="hud">{session.hud}</div>}
    </div>
  )
}
