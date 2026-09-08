/**
 * The alerts a plugin is blocked on, and who they belong to.
 *
 * `confirmAlert` parks the worker on an RPC with no timeout: it is *supposed*
 * to block until a human answers. That makes the resolver a liability the
 * moment the session behind it ends. Hiding the panel used to delete the
 * session and leave the resolver here for the life of the host process, the
 * plugin's `await` never returning.
 *
 * The policy, the same one `headless-alert.ts` states: a session that closes
 * dismisses its alerts, never confirms them. The alert exists because the
 * plugin wanted a human in front of a destructive branch.
 */
export class AlertRegistry {
  private readonly pending = new Map<string, { sessionId: string; resolve: (confirmed: boolean) => void }>()

  register(sessionId: string, token: string, resolve: (confirmed: boolean) => void): void {
    this.pending.set(token, { sessionId, resolve })
  }

  /** Whether the token named an alert still waiting. A second answer is a no-op. */
  answer(token: string, confirmed: boolean): boolean {
    const entry = this.pending.get(token)
    if (entry === undefined) return false
    this.pending.delete(token)
    entry.resolve(confirmed)
    return true
  }

  /** Every alert of that session is dismissed; other sessions' are untouched. */
  closeSession(sessionId: string): void {
    for (const [token, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(token)
      entry.resolve(false)
    }
  }

  closeAll(): void {
    for (const [token, entry] of this.pending) {
      this.pending.delete(token)
      entry.resolve(false)
    }
  }

  get size(): number {
    return this.pending.size
  }
}
