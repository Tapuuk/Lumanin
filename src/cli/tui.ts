import { emitKeypressEvents, type Interface } from 'node:readline'

/**
 * A small terminal UI: enough of one to configure a launcher, and no more.
 *
 * Hand-written rather than pulled from npm, for the same reason the rest of this
 * project is careful about dependencies: this runs on a user's machine on the
 * day they install the app, before they trust it with anything, and a menu is
 * not worth a supply chain. It is ~300 lines of ANSI and a keypress switch.
 *
 * Every frame is redrawn in place — the cursor moves back up over the previous
 * one and erases forward — so the screen never scrolls and whatever the user had
 * in their scrollback is still there when this exits. That is also why lines are
 * truncated to the terminal width: a line that wraps is two lines, and the
 * redraw would then leave debris behind.
 */

export interface Term {
  readonly input: NodeJS.ReadStream
  readonly output: NodeJS.WriteStream
}

export interface Key {
  readonly name: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  /** The literal character, for text entry. */
  readonly sequence: string
}

const ESC = '\u001b'
const CSI = `${ESC}[`

/** Styling, honouring `NO_COLOR` and a non-terminal stdout. */
export class Style {
  constructor(private readonly enabled: boolean) {}

  static for(term: Term, env: Readonly<Record<string, string | undefined>>): Style {
    return new Style(term.output.isTTY === true && env['NO_COLOR'] === undefined)
  }

  private wrap(code: string, text: string): string {
    return this.enabled ? `${CSI}${code}m${text}${CSI}0m` : text
  }

  bold = (text: string): string => this.wrap('1', text)
  dim = (text: string): string => this.wrap('2', text)
  accent = (text: string): string => this.wrap('36', text)
  warn = (text: string): string => this.wrap('33', text)
  good = (text: string): string => this.wrap('32', text)
  bad = (text: string): string => this.wrap('31', text)
  selected = (text: string): string => this.wrap('7', text)
}

/** Printable width, ignoring the escape sequences that take no columns. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length
}

/** Truncate to a column count without cutting an escape sequence in half. */
export function truncate(text: string, columns: number): string {
  if (width(text) <= columns) return text

  let visible = 0
  let out = ''
  let index = 0
  while (index < text.length) {
    if (text.startsWith(`${CSI}`, index)) {
      const end = text.indexOf('m', index)
      if (end !== -1) {
        out += text.slice(index, end + 1)
        index = end + 1
        continue
      }
    }
    if (visible >= columns - 1) break
    out += text[index]
    visible += 1
    index += 1
  }
  return `${out}…${CSI}0m`
}

/**
 * Draws frames in place. One instance per interactive session, because it has to
 * remember how tall the last frame was.
 */
export class Screen {
  private drawn = 0

  constructor(private readonly term: Term) {}

  /**
   * A terminal that reports nothing useful gets 80×24 rather than the truth.
   *
   * `?? 80` is not enough: a pty whose size was never set reports **0**, and a
   * zero-width terminal truncates every line to a single ellipsis — which is
   * exactly what it looked like the first time this ran under `script`.
   */
  get columns(): number {
    const columns = this.term.output.columns
    return columns === undefined || columns < 20 ? 80 : columns
  }

  get rows(): number {
    const rows = this.term.output.rows
    return rows === undefined || rows < 8 ? 24 : rows
  }

  draw(lines: readonly string[]): void {
    const frame = lines.map((line) => truncate(line, this.columns))
    const move = this.drawn > 0 ? `${CSI}${String(this.drawn)}A` : ''
    // `0J` erases from the cursor to the end of the screen, which is what makes
    // a frame shorter than its predecessor not leave the difference behind.
    this.term.output.write(`\r${move}${CSI}0J${frame.join('\n')}\n`)
    this.drawn = frame.length
  }

  /** Leave the last frame on screen and stop tracking it. */
  release(): void {
    this.drawn = 0
  }

  /** Erase the last frame entirely — used when a screen is replaced. */
  erase(): void {
    if (this.drawn === 0) return
    this.term.output.write(`\r${CSI}${String(this.drawn)}A${CSI}0J`)
    this.drawn = 0
  }

  hideCursor(): void {
    this.term.output.write(`${CSI}?25l`)
  }

  showCursor(): void {
    this.term.output.write(`${CSI}?25h`)
  }
}

/**
 * One keypress subscription for the whole session.
 *
 * Deliberately not one per screen. Subscribing and unsubscribing around every
 * menu loses whatever was typed in the gap — which is not a theoretical race:
 * it showed up immediately as a scripted run where every key after the second
 * screen simply vanished, and it would show up for any user who types ahead.
 * Keys that arrive while no screen is listening are queued and delivered to the
 * next one, which is what a terminal program is expected to do.
 */
/** How long a lone Escape waits to prove it is not an arrow key. */
export const ESCAPE_CODE_TIMEOUT_MS = 25

export class Keys {
  private handler: ((key: Key) => 'continue' | 'done') | null = null
  private resolve: (() => void) | null = null
  private readonly queued: Key[] = []
  private readonly wasRaw: boolean

  constructor(
    private readonly term: Term,
    private readonly onInterrupt: () => void
  ) {
    // 25 ms, not Node's 500. `Escape` is the first byte of every arrow key, so
    // the keypress decoder holds a lone one back to see whether more of a
    // sequence follows — and Node's default wait is half a second, which is
    // exactly how long Esc took to do anything in this menu. Measured: 502 ms
    // against 26 ms.
    //
    // 25 ms is vim's `ttimeoutlen` and is the same trade: an arrow key arrives
    // as one write, so the timer only ever runs for a real, lone Escape. A
    // connection slow enough to split three bytes across 25 ms would misread
    // one arrow press as Esc, which is recoverable; half a second of apparent
    // deadness on every Esc is not.
    // `@types/node` types the second argument as a whole `Interface`; Node reads
    // exactly one property off it, which is this one.
    emitKeypressEvents(term.input, {
      escapeCodeTimeout: ESCAPE_CODE_TIMEOUT_MS
    } as unknown as Interface)
    this.wasRaw = term.input.isRaw === true
    if (term.input.isTTY) term.input.setRawMode(true)
    term.input.resume()
    term.input.on('keypress', this.listener)
  }

  private readonly listener = (sequence: string, key: Partial<Key> | undefined): void => {
    const pressed: Key = {
      name: key?.name ?? '',
      ctrl: key?.ctrl ?? false,
      shift: key?.shift ?? false,
      meta: key?.meta ?? false,
      sequence: key?.sequence ?? sequence ?? ''
    }

    // Ctrl+C is handled here rather than by each caller: a menu that could
    // swallow it would be a menu you cannot get out of, which is the one
    // unforgivable thing for a program that takes over the terminal.
    if (pressed.ctrl && (pressed.name === 'c' || pressed.name === 'd')) {
      this.dispose()
      this.onInterrupt()
      return
    }

    this.deliver(pressed)
  }

  private deliver(key: Key): void {
    const handler = this.handler
    if (handler === null) {
      this.queued.push(key)
      return
    }
    if (handler(key) !== 'done') return

    const done = this.resolve
    this.handler = null
    this.resolve = null
    done?.()
  }

  /** Resolve once `onKey` returns `'done'`. */
  read(onKey: (key: Key) => 'continue' | 'done'): Promise<void> {
    return new Promise((resolve) => {
      this.handler = onKey
      this.resolve = resolve
      while (this.handler !== null) {
        const next = this.queued.shift()
        if (next === undefined) break
        this.deliver(next)
      }
    })
  }

  dispose(): void {
    this.term.input.off('keypress', this.listener)
    if (this.term.input.isTTY) this.term.input.setRawMode(this.wasRaw)
    this.term.input.pause()
  }
}

/**
 * Abandoning a flow: Esc, from any depth, back to the menu it started from.
 *
 * A thrown value rather than a return code, and deliberately. "Go back one
 * screen" is a local decision that every caller already handles — a `null` from
 * the menu — but "throw away this whole multi-step thing" has to unwind an
 * arbitrary stack of nested screens, each of which is sitting in its own `for
 * (;;)` loop waiting to redraw itself. Threading a second return value through
 * every one of them would work exactly as long as nobody forgot a check, and
 * the failure of forgetting is silent: one screen swallows the abandon and the
 * user watches it redraw instead of leaving.
 *
 * Caught in exactly one place — the top-level menu loop — which is also the only
 * place that knows what "the beginning" means.
 */
export class AbandonedFlow extends Error {
  constructor() {
    super('the user abandoned this flow')
    this.name = 'AbandonedFlow'
  }
}

export function isAbandoned(error: unknown): boolean {
  return error instanceof AbandonedFlow
}

/**
 * What a wizard step did: went forward, or asked to go back one screen.
 *
 * There is no third outcome for "cancel the lot" because cancelling does not
 * return — {@link AbandonedFlow} unwinds through the wizard along with
 * everything else.
 */
export type StepOutcome = 'next' | 'back'

/**
 * A sequence of screens where Esc means "back one step", not "throw all of it away".
 *
 * Anything that asks more than one question needs this. Adding a search asks for
 * a site, a URL, a name and a keyword; before this, pressing Esc at the keyword —
 * the last of the four — discarded the other three and returned to the list, so a
 * typo in the last answer cost every answer. That is not what Esc means anywhere
 * else in this menu, where it reliably backs out of exactly one thing.
 *
 * Steps share state by closing over it rather than by passing values along: a
 * step that is re-entered has to show what was typed the first time, so the value
 * has to outlive the step that produced it either way.
 *
 * Resolves `true` when every step completed, and `false` when the user backed out
 * past the first one.
 */
export async function wizard(steps: readonly (() => Promise<StepOutcome>)[]): Promise<boolean> {
  let at = 0
  while (at < steps.length) {
    const step = steps[at]
    // Unreachable while `at` is in range; the compiler does not know that, and
    // treating it as "nothing more to do" is the safe reading if it ever is.
    if (step === undefined) return false
    at += (await step()) === 'back' ? -1 : 1
    if (at < 0) return false
  }
  return true
}

export interface Choice<T> {
  readonly value: T
  readonly label: string
  /** Right-hand column: the current value, a count, a hint. */
  readonly detail?: string
  /** Dimmed line under the label. */
  readonly help?: string
  /** A non-selectable heading or rule. */
  readonly separator?: boolean
  /** Rendered before the label — `[x]`, `1.`, a pin marker. */
  readonly prefix?: string
}

export interface ListSpec<T> {
  readonly title: string
  readonly subtitle?: string
  /**
   * A function when the list edits what it is listing — toggling an engine,
   * reordering a pin — so a redraw shows the new state rather than the state the
   * screen was opened with.
   */
  readonly choices: readonly Choice<T>[] | (() => readonly Choice<T>[])
  readonly initialIndex?: number
  /** Extra key hints for the footer, beyond move/select/back. */
  readonly hints?: readonly string[]
  /** What Esc does here. The top menu leaves rather than goes back. */
  readonly escHint?: string
  /**
   * What Esc does here. `'abandon'` — the default — throws
   * {@link AbandonedFlow}, which unwinds every screen between here and the menu
   * the flow started from. `'close'` is for that menu itself, where there is
   * nothing left to abandon and Esc means what it has always meant.
   */
  readonly escape?: 'abandon' | 'close'
  /**
   * Keys the caller wants to handle itself — deleting a row, reordering. Return
   * `'handled'` to redraw, `'close'` to leave the list with that result.
   */
  readonly onKey?: (
    key: Key,
    value: T | null,
    index: number,
    list: ListControl
  ) => 'ignored' | 'handled' | 'close'
}

/** What a caller's `onKey` is allowed to do to the list itself. */
export interface ListControl {
  /** Put the highlight on this row index. */
  moveTo(index: number): void
  /**
   * Keep the highlight on this *value*, wherever the row has just moved to.
   *
   * Every screen that edits the list it is showing needs this, and each one
   * broke without it in its own way. Reordering: Shift+↑ moves the row up, the
   * highlight stays, and the next press moves whatever took its place back down
   * — two rows trading places forever. Toggling: an enabled engine jumps to the
   * top group, the highlight lands on the separator, gets clamped to row 0, and
   * the next Space toggles the row you just enabled straight back off.
   *
   * Call it *after* writing the new state — the choices are recomputed here, so
   * it finds where the value ended up rather than where it was.
   */
  follow(value: unknown): void
}

export interface ListResult<T> {
  /** `null` when the user backed out with Esc. */
  readonly value: T | null
  /** True when `onKey` asked to close, so the caller knows why it returned. */
  readonly viaKey: boolean
  readonly index: number
}

/**
 * The lines a list frame spends on things other than rows: the blank above
 * the title, the title, the blank under it, the help slot, the overflow line,
 * the blank above the hints, the hints — and a spare, so the frame never
 * reaches the last terminal row (a frame taller than the terminal cannot be
 * redrawn in place, and leaves its top behind on every keypress).
 */
const LIST_CHROME = 8

/** The most rows a list draws at once, however tall the terminal. */
const MAX_ROWS = 20

export class Menu {
  private readonly style: Style
  private readonly keys: Keys

  constructor(
    private readonly term: Term,
    private readonly screen: Screen,
    env: Readonly<Record<string, string | undefined>>
  ) {
    this.style = Style.for(term, env)
    this.keys = new Keys(term, () => this.interrupt())
  }

  /** Give the terminal back. Every exit path must call this. */
  close(): void {
    this.keys.dispose()
    this.screen.showCursor()
  }

  get styles(): Style {
    return this.style
  }

  /** A list of choices. Resolves with the chosen value, or `null` on Esc. */
  async list<T>(spec: ListSpec<T>): Promise<ListResult<T>> {
    const s = this.style
    let cursor = spec.initialIndex ?? 0
    let viaKey = false
    let abandon = false
    let closed: T | null = null

    const selectable = (choices: readonly Choice<T>[]): number[] =>
      choices.map((c, i) => (c.separator === true ? -1 : i)).filter((i) => i !== -1)

    const all = (): readonly Choice<T>[] =>
      typeof spec.choices === 'function' ? spec.choices() : spec.choices

    const visible = (): readonly Choice<T>[] => all()

    // The first row on screen. Kept between renders and moved only when the
    // highlight leaves the window, so the list holds still while you move
    // through it: rows only scroll when they have to, never to recentre.
    let start = 0

    const clamp = (): void => {
      const rows = selectable(visible())
      if (rows.length === 0) {
        cursor = 0
        return
      }
      if (!rows.includes(cursor)) cursor = rows[0] ?? 0
    }

    const move = (delta: number): void => {
      const rows = selectable(visible())
      if (rows.length === 0) return
      const at = rows.indexOf(cursor)
      const next = at === -1 ? 0 : (at + delta + rows.length) % rows.length
      cursor = rows[next] ?? 0
    }

    const render = (): void => {
      const shown = visible()
      clamp()

      const lines: string[] = ['', `  ${s.bold(spec.title)}`]
      if (spec.subtitle !== undefined) lines.push(`  ${s.dim(spec.subtitle)}`)
      lines.push('')

      // A viewport, so a 500-application picker does not redraw the world.
      const capacity = Math.max(4, Math.min(MAX_ROWS, this.screen.rows - LIST_CHROME - (spec.subtitle === undefined ? 0 : 1)))
      const at = Math.max(0, cursor)
      if (at < start) start = at
      if (at >= start + capacity) start = at - capacity + 1
      start = Math.max(0, Math.min(start, shown.length - capacity))
      const window = shown.slice(start, start + capacity)

      if (window.length === 0) lines.push(`    ${s.dim('nothing matches')}`)

      const labelWidth = Math.max(
        ...window.map((choice) => width(`${choice.prefix ?? ''}${choice.label}`)),
        0
      )

      for (const choice of window) {
        const index = shown.indexOf(choice)
        if (choice.separator === true) {
          lines.push(`    ${s.dim(choice.label)}`)
          continue
        }

        const here = index === cursor
        const label = `${choice.prefix ?? ''}${choice.label}`
        const padded =
          choice.detail === undefined ? label : label.padEnd(labelWidth + (label.length - width(label)))
        const detail = choice.detail === undefined ? '' : `  ${s.dim(choice.detail)}`
        lines.push(`  ${here ? s.accent('❯') : ' '} ${here ? s.bold(padded) : padded}${detail}`)
      }

      // Fixed slots, whatever the highlighted row has to say and wherever the
      // window sits: a line that comes and goes shifts everything under it.
      if (shown.length > window.length) {
        const above = start
        const below = shown.length - start - window.length
        const parts = [
          ...(above > 0 ? [`↑ ${String(above)} above`] : []),
          ...(below > 0 ? [`↓ ${String(below)} below`] : [])
        ]
        lines.push(`    ${s.dim(parts.join(' · '))}`)
      }
      const help = shown[cursor]?.help
      lines.push(help === undefined ? '' : `    ${s.dim(help)}`)

      lines.push('')
      const hints = [
        '↑↓ move',
        'space select',
        ...(spec.hints ?? []),
        spec.escHint ?? (spec.escape === 'close' ? 'esc back' : '← back · esc menu')
      ]
      lines.push(`  ${s.dim(hints.join(' · '))}`)
      this.screen.draw(lines)
    }

    this.screen.hideCursor()
    render()

    await this.keys.read((key) => {
        const shown = visible()
        const current = shown[cursor]
        const value = current === undefined || current.separator === true ? null : current.value

        if (spec.onKey !== undefined) {
          const outcome = spec.onKey(key, value, cursor, {
            moveTo: (index) => {
              cursor = index
            },
            follow: (target) => {
              const index = visible().findIndex(
                (choice) => choice.separator !== true && choice.value === target
              )
              if (index !== -1) cursor = index
            }
          })
          if (outcome === 'close') {
            viaKey = true
            closed = value
            return 'done'
          }
          if (outcome === 'handled') {
            render()
            return 'continue'
          }
        }

        switch (key.name) {
          case 'up':
          case 'k':
            move(-1)
            render()
            return 'continue'
          case 'down':
          case 'j':
            move(1)
            render()
            return 'continue'
          case 'space':
          case 'return':
          // → is Enter. The pair reads as a direction rather than as two
          // unrelated keys: ← leaves the screen you are on, → goes into the row
          // you are on. A screen that wants → for something of its own — the
          // plugin browser, where "into" and "choose" are genuinely different
          // verbs — takes it in `onKey`, which runs before this.
          case 'right':
            if (value === null) return 'continue'
            closed = value
            return 'done'
          case 'left':
            // One step back, always — the local half of the pair. Never abandons,
            // so a wizard's earlier answers survive being reconsidered.
            closed = null
            return 'done'
          case 'escape':
            closed = null
            abandon = spec.escape !== 'close'
            return 'done'
          default:
            break
        }
        return 'continue'
    })

    this.screen.showCursor()
    // Thrown *after* the key loop has resolved, never from inside it: the
    // handler runs on a stream event, where a throw is an uncaught exception
    // rather than a rejected promise.
    if (abandon) throw new AbandonedFlow()
    return { value: closed, viaKey, index: cursor }
  }

  /** A single line of text. Resolves `null` on Esc. */
  async prompt(spec: {
    readonly title: string
    readonly help?: string
    readonly initial?: string
    /**
     * What the footer says the back keys do. ← always goes back one step;
     * inside a `wizard` that is the previous question, elsewhere the previous
     * screen — and the footer has to say which, because a screen that offers
     * "cancel" and then reappears one step earlier reads as a bug.
     */
    readonly escHint?: string
    /** As {@link ListSpec.escape}. Defaults to abandoning the whole flow. */
    readonly escape?: 'abandon' | 'close'
    /**
     * Draw the value as dots.
     *
     * For an extension's `password` preference — an API key typed into a
     * terminal is a key in that terminal's scrollback, and scrollback outlives
     * this screen by a long way.
     */
    readonly mask?: boolean
    /** Return a message to reject the value, or `null` to accept it. */
    readonly validate?: (value: string) => string | null
  }): Promise<string | null> {
    const s = this.style
    let value = spec.initial ?? ''
    let problem: string | null = null
    let result: string | null = null

    const render = (): void => {
      const lines = ['', `  ${s.bold(spec.title)}`]
      if (spec.help !== undefined) lines.push(`  ${s.dim(spec.help)}`)
      const shown = spec.mask === true ? '•'.repeat(value.length) : value
      lines.push('', `  ${s.accent('›')} ${shown}${s.dim('▏')}`)
      if (problem !== null) lines.push(`  ${s.bad(`! ${problem}`)}`)
      lines.push(
        '',
        `  ${s.dim(`enter accept · ${spec.escHint ?? (spec.escape === 'close' ? 'esc cancel' : '← back · esc menu')}`)}`
      )
      this.screen.draw(lines)
    }

    this.screen.hideCursor()
    render()

    let abandon = false
    await this.keys.read((key) => {
        // The same pair as the list: ← is one step back, Esc throws the flow
        // away. A prompt appends printable characters and has no caret to move,
        // so ← is free here — which is what makes the pair consistent rather
        // than "except in text fields".
        if (key.name === 'left') {
          result = null
          return 'done'
        }
        if (key.name === 'escape') {
          result = null
          abandon = spec.escape !== 'close'
          return 'done'
        }
        if (key.name === 'return') {
          problem = spec.validate?.(value) ?? null
          if (problem !== null) {
            render()
            return 'continue'
          }
          result = value
          return 'done'
        }
        if (key.name === 'backspace') {
          value = value.slice(0, -1)
          problem = null
          render()
          return 'continue'
        }
        if (key.ctrl && key.name === 'u') {
          value = ''
          render()
          return 'continue'
        }
        if (key.sequence.length === 1 && !key.ctrl && key.sequence >= ' ') {
          value += key.sequence
          problem = null
          render()
        }
        return 'continue'
    })

    this.screen.showCursor()
    if (abandon) throw new AbandonedFlow()
    return result
  }

  async confirm(question: string, detail?: string): Promise<boolean> {
    const answer = await this.list<boolean>({
      title: question,
      ...(detail === undefined ? {} : { subtitle: detail }),
      choices: [
        { value: true, label: 'Yes' },
        { value: false, label: 'No' }
      ],
      initialIndex: 1
    })
    return answer.value === true
  }

  /** Show a block of text and wait for a key. Used for the save preview. */
  async show(title: string, body: readonly string[], hint = 'any key to go back'): Promise<void> {
    this.screen.hideCursor()
    this.screen.draw(this.block(title, body, hint))
    await this.keys.read(() => 'done')
    this.screen.showCursor()
  }

  /**
   * Draw a block and return immediately.
   *
   * For work that takes long enough to need saying so — fetching a repository,
   * running `npm install` — where the alternative is a screen that says nothing
   * for ninety seconds and reads as a hang. It waits for no key precisely
   * because there is nothing to decide yet.
   */
  showNow(title: string, body: readonly string[]): void {
    this.screen.hideCursor()
    this.screen.draw(this.block(title, body, 'working…'))
  }

  private block(title: string, body: readonly string[], hint: string): readonly string[] {
    const s = this.style
    const room = Math.max(4, this.screen.rows - 8)
    // The *last* lines, not the first: a progress log grows downward and the
    // interesting end of it is the bottom.
    const shown = body.length > room ? body.slice(body.length - room) : body
    return [
      '',
      `  ${s.bold(title)}`,
      '',
      ...(body.length > shown.length
        ? [`  ${s.dim(`… ${String(body.length - shown.length)} earlier lines`)}`]
        : []),
      ...shown.map((line) => `  ${line}`),
      '',
      `  ${s.dim(hint)}`
    ]
  }

  /** Print outside the redraw region — the frame above it stays put. */
  say(text: string): void {
    this.screen.release()
    this.term.output.write(`${text}\n`)
  }

  private interrupt(): void {
    this.screen.showCursor()
    this.term.output.write('\n')
    process.exit(130)
  }
}
