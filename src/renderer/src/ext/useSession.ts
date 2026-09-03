import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlertPayload, ToastPayload } from '@shared/ext-protocol'
import type { SessionInfo } from '@shared/ipc'
import { applyRenderPatches } from '@shared/render-patch'
import { emptyTree, type RenderNode } from '@shared/render-tree'

/**
 * The renderer's half of an extension session.
 *
 * It holds exactly one authoritative thing — the tree — and applies patches to
 * it. Everything else here (toast, alert, HUD, the fatal error) is chrome that
 * arrives on its own channel and is deliberately *not* in the tree, so an
 * extension re-rendering cannot take away a toast it showed a moment ago.
 *
 * The renderer never mutates the tree on its own. Pressing an action sends an
 * event and waits; even `pop` waits. That is what makes the worker the single
 * source of truth rather than one of two.
 */

export interface SessionState {
  readonly session: SessionInfo | null
  readonly tree: RenderNode
  readonly toast: ToastPayload | null
  readonly alert: AlertPayload | null
  readonly hud: string | null
  /** Set when the session died. The view is gone; this is what replaces it. */
  readonly failure: { message: string; stack: string | null } | null
  readonly searchText: string
  setSearchText(text: string): void
  /**
   * An item id the view should land on: from `SessionInfo.select` (a pinned
   * item), or from the extension calling `selectItemWithId`. Consumed by the
   * view once the row exists, and dropped the moment the user moves the cursor
   * — a stale "go here" must never fight the person holding the arrows.
   */
  readonly requestedItem: string | null
  clearRequestedItem(): void
  /**
   * `focus()` or `reset()` on a form field ref, addressed by the field's `id`.
   *
   * Carries a `seq` because the same instruction repeated is still an
   * instruction — an extension that focuses the same field after each failed
   * submit sends an identical payload every time, and an effect keyed on the
   * value alone would run once and never again.
   */
  readonly fieldCommand: { action: 'focus' | 'reset'; id: string; seq: number } | null
  begin(session: SessionInfo): void
  end(): void
  answerAlert(confirmed: boolean): void
}

/** How long a HUD stays up before it fades. Raycast's is about this. */
const HUD_MS = 1800

/**
 * How long a finished toast stays.
 *
 * Only `SUCCESS` and `FAILURE` are finished. An `ANIMATED` toast means work is
 * still happening and must stay until the extension replaces or hides it —
 * dismissing that one on a timer would report a job as over while it is running.
 */
const TOAST_MS = 2600

export function useSession(): SessionState {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [tree, setTree] = useState<RenderNode>(emptyTree)
  const [toast, setToast] = useState<ToastPayload | null>(null)
  const [alert, setAlert] = useState<AlertPayload | null>(null)
  const [hud, setHud] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; stack: string | null } | null>(null)
  const [searchText, setSearchText] = useState('')
  const [requestedItem, setRequestedItem] = useState<string | null>(null)
  const [fieldCommand, setFieldCommand] = useState<SessionState['fieldCommand']>(null)

  /**
   * The last revision applied.
   *
   * A patch is only meaningful against the exact document it was computed from,
   * and a patch applied to the wrong base does not fail — it silently produces a
   * tree that never existed on either side. Dropping anything out of order is the
   * only safe response; the worker's next commit carries the difference anyway.
   */
  const revision = useRef(0)
  const active = useRef<string | null>(null)

  /**
   * The tree again, in a ref, and the one writer that keeps the two in step.
   *
   * A batch is applied where it arrives rather than inside a state updater: an
   * updater runs twice under strict mode and has nowhere to report a batch it
   * could not apply. Applying eagerly means the failure can be answered — by
   * fetching the document again — and it means the revision advances only when
   * a batch actually lands.
   */
  const treeRef = useRef(tree)
  const putTree = useCallback((next: RenderNode) => {
    treeRef.current = next
    setTree(next)
  }, [])

  const begin = useCallback((next: SessionInfo) => {
    active.current = next.sessionId
    // The snapshot the launch carried, not an empty tree: the command rendered
    // while it was starting, so that first batch is already history by the time
    // this runs. See `SessionInfo.tree`.
    revision.current = next.revision
    setSession(next)
    putTree(next.tree)
    setToast(null)
    setAlert(null)
    // Usually `null`. It is not when the command died before this ran, in which
    // case the `ext.ended` that carried the crash was dropped for naming a
    // session nobody was watching yet — see `SessionInfo.failure`.
    setFailure(next.failure)
    setSearchText('')
    setRequestedItem(next.select)
    setFieldCommand(null)
  }, [putTree])

  const end = useCallback(() => {
    const current = active.current
    active.current = null
    setSession(null)
    putTree(emptyTree())
    setToast(null)
    setAlert(null)
    setFailure(null)
    setSearchText('')
    setRequestedItem(null)
    setFieldCommand(null)
    if (current !== null) void window.lumanin.invoke('ext.close', { sessionId: current })
  }, [putTree])

  useEffect(() => {
    const offRender = window.lumanin.on('ext.render', (update) => {
      if (update.sessionId !== active.current) return
      // Already applied — a snapshot we started from covered it.
      if (update.revision <= revision.current) return

      // A gap. A patch is only meaningful against the exact document it was
      // computed from, and applying one to the wrong base does not fail — it
      // quietly produces a tree that never existed on either side. So the batch
      // is dropped and the whole document is fetched instead. Main can always
      // answer, because it materialises the tree as the patches pass through.
      if (update.revision !== revision.current + 1) {
        void resync(update.sessionId)
        return
      }

      let next: RenderNode
      try {
        // A new root every batch, because React decides what to redraw by
        // comparing identities — but only the nodes the batch named are new,
        // so a row that changed does not cost its neighbours a redraw.
        next = applyRenderPatches(treeRef.current, update.patches)
      } catch {
        // The batch does not fit the document we are holding, which means the
        // document is wrong. There is nothing to log to and nothing to salvage;
        // the revision stays put and the whole tree is fetched again.
        void resync(update.sessionId)
        return
      }
      revision.current = update.revision
      putTree(next)
    })

    /** In flight, so a burst of gaps costs one fetch rather than one each. */
    let resyncing: Promise<void> | null = null

    const resync = (sessionId: string): Promise<void> => {
      if (resyncing !== null) return resyncing
      const pending = (async () => {
        const snapshot = await window.lumanin.invoke('ext.attach', { sessionId })
        if (snapshot === null || sessionId !== active.current) return
        // Equal revisions are equal trees, and swapping one for the other would
        // throw away every node the two have in common.
        if (snapshot.revision <= revision.current) return
        revision.current = snapshot.revision
        putTree(snapshot.tree)
      })().finally(() => {
        if (resyncing === pending) resyncing = null
      })
      resyncing = pending
      return pending
    }

    const offToast = window.lumanin.on('ext.toast', ({ sessionId, toast: next }) => {
      if (sessionId !== active.current) return
      setToast(next)
    })

    const offAlert = window.lumanin.on('ext.alert', (payload) => {
      if (payload.sessionId !== active.current) return
      setAlert(payload)
    })

    const offHud = window.lumanin.on('ext.hud', ({ title }) => {
      // Deliberately not gated on the session: `showHUD` closes the panel, so by
      // the time this arrives the session it came from may already be over. That
      // is the normal case rather than a race.
      setHud(title)
    })

    const offEnded = window.lumanin.on('ext.ended', ({ sessionId, message, stack }) => {
      if (sessionId !== active.current) return
      if (message === null) {
        // A clean finish: the command did what it was for.
        active.current = null
        setSession(null)
        putTree(emptyTree())
        return
      }
      // A crash keeps the session object so the error card can name the command
      // and offer to reload it. The tree is gone; there is nothing left to draw.
      setFailure({ message, stack })
    })

    const offCommand = window.lumanin.on('ext.command', ({ sessionId, action, value }) => {
      if (sessionId !== active.current) return
      if (action === 'clearSearchBar') setSearchText('')
      if (action === 'selectItem') setRequestedItem(value)
      if ((action === 'focusField' || action === 'resetField') && value !== null) {
        const what = action === 'focusField' ? 'focus' : 'reset'
        setFieldCommand((previous) => ({ action: what, id: value, seq: (previous?.seq ?? 0) + 1 }))
      }
    })

    return () => {
      offRender()
      offToast()
      offAlert()
      offHud()
      offEnded()
      offCommand()
    }
  }, [putTree])

  useEffect(() => {
    if (hud === null) return
    const timer = setTimeout(() => setHud(null), HUD_MS)
    return () => clearTimeout(timer)
  }, [hud])

  useEffect(() => {
    if (toast === null || toast.style === 'ANIMATED') return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const answerAlert = useCallback(
    (confirmed: boolean) => {
      if (alert === null) return
      setAlert(null)
      void window.lumanin.invoke('ext.alertAnswer', { token: alert.token, confirmed })
    },
    [alert]
  )

  return {
    session,
    tree,
    toast,
    alert,
    hud,
    failure,
    searchText,
    setSearchText,
    requestedItem,
    clearRequestedItem: useCallback(() => setRequestedItem(null), []),
    fieldCommand,
    begin,
    end,
    answerAlert
  }
}
