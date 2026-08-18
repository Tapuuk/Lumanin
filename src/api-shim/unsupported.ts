/**
 * The APIs that cannot work here, and the rule for saying so.
 *
 * The macOS-only policy is binding and has one line worth
 * repeating: **throw, never no-op.** A `getSelectedFinderItems()` that quietly
 * resolves to `[]` turns "this needs Finder" into a bug report about an
 * extension that returns nothing for no reason — and the person who has to
 * diagnose it has neither our source nor the extension's.
 *
 * The registry here is not decoration either. The store's compatibility scanner
 * is built out of *this set*, derived at scan time
 * rather than hand-maintained, so adding a member here teaches the scanner about
 * it the same day and the two cannot drift.
 */

/**
 * Marks stamped on the member itself, so `scripts/compat-coverage.mjs` can tell
 * a built export from a stub that merely exists under the right name.
 *
 * Symbols rather than an exported registry, for two reasons. The script reads
 * the *built* bundle, where a module-local `Map` is unreachable; and `lumanin`
 * is a plugin's front door, which does not get an extra public export just so a
 * script of ours can introspect it. `Symbol.for` keeps them findable across the
 * bundle boundary without either module importing the other.
 *
 * Without this the coverage ratio counts names, and a `pending()` that throws on
 * first call reads as implemented — which is exactly how the coverage number
 * once reported 88/88 with a third of it unbuilt.
 */
export const PENDING = Symbol.for('lumanin.pending')
export const UNSUPPORTED = Symbol.for('lumanin.unsupported')
export const DECLINED = Symbol.for('lumanin.declined')

/** The error every unsupported member throws. Extensions can catch it by name. */
export class PlatformNotSupportedError extends Error {
  readonly api: string

  constructor(api: string, reason: string) {
    super(`${api} is not available on Linux: ${reason}`)
    this.name = 'PlatformNotSupportedError'
    this.api = api
  }
}

const registry = new Map<string, string>()
const members = new WeakSet<object>()

/**
 * Build a member that throws.
 *
 * Typed as whatever it replaces, so an extension compiled against the real API
 * type-checks against ours — the difference shows up when it is *called*, which
 * is the only place it can honestly show up.
 */
export function unsupported<T>(api: string, reason: string): T {
  registry.set(api, reason)
  const thrower = (): never => {
    throw new PlatformNotSupportedError(api, reason)
  }
  Object.defineProperty(thrower, 'name', { value: api })
  Object.defineProperty(thrower, UNSUPPORTED, { value: reason })
  members.add(thrower)
  return thrower as T
}

/** Mark an already-built object as unsupported — a namespace, say, rather than a function. */
export function markUnsupported<T extends object>(api: string, reason: string, member: T): T {
  registry.set(api, reason)
  Object.defineProperty(member, UNSUPPORTED, { value: reason })
  members.add(member)
  return member
}

/**
 * Not *impossible* here — just not available right now.
 *
 * The distinction is load-bearing and easy to lose. {@link unsupported} feeds the
 * store's compatibility scanner, which reads it as "this extension cannot work on
 * Linux". An API that is merely unbuilt, or one the user has not configured (AI
 * with no provider), is a different claim: `canAccess` must answer `false` so an
 * extension takes its fallback path, but the scanner must not condemn the
 * extension for importing it — that would rate half the store `UNSUPPORTED` for
 * features we are going to ship.
 */
export function markUnavailable<T extends object>(member: T): T {
  members.add(member)
  return member
}

/**
 * A member that is planned but not built, which throws saying so.
 *
 * Deliberately a plain `Error` and deliberately not registered: it is not a
 * platform limitation, and labelling it as one would be a claim about Linux that
 * is simply untrue.
 */
export function pending<T>(api: string, reason: string): T {
  const thrower = (): never => {
    throw new Error(`${api} is not implemented yet: ${reason}`)
  }
  Object.defineProperty(thrower, 'name', { value: api })
  Object.defineProperty(thrower, PENDING, { value: reason })
  markUnavailable(thrower)
  return thrower as T
}

/**
 * A member we are not going to build, and the reason.
 *
 * The third state, and it exists because the other two would both be lies about
 * OAuth. {@link pending} says "later", and there is no later. {@link unsupported}
 * says "Linux cannot do this", and Linux can do it perfectly well — the
 * launcher has chosen not to broker sign-in, because it has no online services
 * and is not going to grow any.
 *
 * The distinction is not bookkeeping. It decides what a plugin author is told to
 * do next: wait, give up, or take the other route. So the reason is required and
 * should name that route.
 */
export function declined<T>(api: string, reason: string): T {
  const thrower = (): never => {
    throw new Error(`${api} is not available in Lumanin: ${reason}`)
  }
  Object.defineProperty(thrower, 'name', { value: api })
  Object.defineProperty(thrower, DECLINED, { value: reason })
  markUnavailable(thrower)
  return thrower as T
}

/** {@link declined}, for something already built — a namespace, or a class that throws. */
export function markDeclined<T extends object>(member: T, reason: string): T {
  Object.defineProperty(member, DECLINED, { value: reason, configurable: true })
  return markUnavailable(member)
}

/**
 * Mark an already-built member as not finished yet.
 *
 * For the case {@link pending} cannot cover: a component that renders, reaches
 * the renderer, and gets the "not supported yet" card because nothing draws it.
 * Replacing it with a thrower would be worse — the card names the element and
 * says the extension is fine, which a stack trace does not.
 */
export function markPending<T extends object>(member: T, reason: string): T {
  Object.defineProperty(member, PENDING, { value: reason, configurable: true })
  return markUnavailable(member)
}

/**
 * Carry a stub's mark onto whatever stands in for it.
 *
 * `throwingAction` wraps its thrower in a component, which buries the mark in a
 * closure: `Action.PickDate` is then a real component and reads as built, while
 * `Action.ShowInFinder` reads as available to `canAccess`. Both are wrong, and
 * wrong in the direction that makes an extension take the path that throws.
 */
export function carryMark<T extends object>(from: unknown, to: T): T {
  if (typeof from !== 'function' && (typeof from !== 'object' || from === null)) return to
  const source = from as Record<symbol, unknown>
  for (const mark of [PENDING, UNSUPPORTED, DECLINED]) {
    if (mark in source) Object.defineProperty(to, mark, { value: source[mark], configurable: true })
  }
  if (members.has(from as object)) members.add(to)
  return to
}

/** Backs `environment.canAccess`, which extensions call to choose a fallback. */
export function isUnsupportedMember(api: unknown): boolean {
  return (typeof api === 'object' || typeof api === 'function') && api !== null
    ? members.has(api as object)
    : false
}

/** The list, for the store scanner and for `lumanin doctor`. Names only, sorted. */
export function unsupportedApis(): readonly { readonly api: string; readonly reason: string }[] {
  return [...registry.entries()]
    .map(([api, reason]) => ({ api, reason }))
    .sort((a, b) => a.api.localeCompare(b.api))
}
