/**
 * Fuzzy matching, scored the way fzf scores — but gated the way a launcher has
 * to gate.
 *
 * Lives in `src/shared` because the renderer needs the *positions*, not just the
 * score: highlighting which characters matched is what makes a fuzzy result
 * legible, and re-deriving them in the renderer would be a second implementation
 * free to disagree with the first.
 *
 * The behaviour worth defending, in order of how much it matters for a launcher:
 *
 *  1. **Consecutive runs win.** "fox" should rank `firefox` over
 *     `f-o-something-x`. A per-character bonus that grows with the run is what
 *     separates a launcher that feels psychic from one that feels random.
 *  2. **Word starts win.** "vsc" should find "Visual Studio Code". Boundaries are
 *     spaces, `-`, `_`, `.`, `/` and camelCase transitions.
 *  3. **Earlier is better**, mildly — a match at the start of the name beats the
 *     same match buried in it.
 *  4. **Shorter is better**, very mildly, as the tie-break. Without it "Files"
 *     and "File Manager Preferences" score identically for "file".
 *
 * ## Why a subsequence is not enough
 *
 * A plain "all the characters, in order" test accepts far more than anyone
 * means. Typing `raycast` matched **LibreOffice Draw**, because its `Keywords=`
 * line is 120 characters of `Vector;Schema;…;Corel Draw;cdr;odg;svg;` and those
 * seven letters really are in there in order. Scoring it low was not enough —
 * with nothing else installed by that name it was still the best match, so it
 * was the top row.
 *
 * So a match now has to be *shaped* like something a person meant, not merely
 * present. {@link isAcceptable} is the gate, and it admits exactly three shapes:
 *
 *  - one contiguous run (a substring — `cast` in `Broadcast`);
 *  - runs that each begin at a word start (an initialism — `vsc` in
 *    `Visual Studio Code`, `gimp` in `GNU Image Manipulation Program`);
 *  - two runs close together (`ff` in `Firefox`), bounded by a span so the two
 *    halves cannot be at opposite ends of a long string.
 *
 * Everything else is rejected before it is scored. That is the difference
 * between a low-ranked wrong answer and no wrong answer.
 *
 * ## Typos
 *
 * Rejecting scattered matches would also reject `racyast`, which is obviously
 * `Raycast` with two letters swapped — and a subsequence test can never accept
 * it, since the `y` comes too late. So a token that matches nothing gets one
 * bounded Damerau-Levenshtein pass against the words of the haystack:
 * transpositions included, **one edit** by default however long the word — two
 * errors is usually a different word, not a typo, and `[search].typos` is the
 * setting for people who disagree (`maxTypos`, below) — and
 * heavily penalised so a real match always outranks a repaired one. This is
 * deliberately *not* a general edit-distance search: within a candidate it fires
 * only where the strict path found nothing, and only against whole words. A
 * caller scoring a whole index can also switch it off with `allowTypos: false`
 * and run it again as a second pass over the same index, which is what keeps
 * thousands of candidates from being repaired for rows that any strict match
 * would have outranked anyway.
 *
 * The algorithm is a greedy forward scan plus a backward tightening pass, not
 * full Smith-Waterman. For strings the length of application names the results
 * are the same, and it stays O(n) per candidate — which matters when every
 * keystroke rescores a few thousand entries.
 */

/**
 * How good a *kind* of match this is, before any scoring.
 *
 * The tier is the primary sort key and the score only breaks ties inside one,
 * because "starts with what I typed" is not a small bonus over "contains it
 * somewhere" — it is a different answer to the question. Scoring alone cannot
 * express that: any bonus large enough to guarantee prefix-first is large enough
 * to make every other signal meaningless.
 *
 * Tiers also fall into three **groups**, and only the best non-empty group is
 * shown at all — see {@link matchGroup}. That is a coarser gate than the sort on
 * purpose: within "the name matched" every tier is worth showing, and between
 * groups none of the weaker ones are.
 */
export const TIER = {
  /** The name begins with what was typed. */
  PREFIX: 0,
  /** The match begins a word inside the name: "draw" in "LibreOffice Draw". */
  WORD_START: 1,
  /** The name contains it, somewhere less convincing. */
  NAME_ELSEWHERE: 2,
  /** Found by something that is not the name — generic name, keywords, exec. */
  NOT_NAME: 3
  ,
  /**
   * Found only by repairing a typo, in any field.
   *
   * Last, and below even a keyword match, because it is the one tier that is a
   * *guess*. "paint" repairs onto "Print Settings" at one edit, and if a guess
   * could outrank an exact match it would take the row from Pinta, whose
   * keywords really do say `paint`.
   */
  TYPO: 4
} as const

export type MatchTier = (typeof TIER)[keyof typeof TIER]

/**
 * The three things a match can be: the name, something else about it, or a
 * guess. Only the best group present is shown.
 */
export function matchGroup(tier: MatchTier): 0 | 1 | 2 {
  return tier <= TIER.NAME_ELSEWHERE ? 0 : tier === TIER.NOT_NAME ? 1 : 2
}

export interface FuzzyMatch {
  readonly score: number
  /** Indices in the haystack that matched, ascending. */
  readonly positions: readonly number[]
  /** Edits needed to make this match. 0 unless the typo path was taken. */
  readonly typos: number
  readonly tier: MatchTier
  /** Where the match starts. Orders rows within a tier — see `matchFields`. */
  readonly at: number
}

const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 7
const BONUS_CONSECUTIVE = 8
const BONUS_FIRST_CHAR = 6
const PENALTY_LEADING = 1
const MAX_LEADING_PENALTY = 12

/**
 * Gaps are penalised, not merely un-bonused, and this is the part that makes the
 * difference between "feels psychic" and "feels random".
 *
 * Rewarding runs is not enough on its own: for "fox", `Fedora Xorg Options`
 * collects two word-start bonuses and beats `Firefox`'s single clean run. Only
 * by charging for the distance *between* matches does the tight match win. The
 * first character of a gap costs the most, so one long gap is cheaper than
 * several short ones — matching a name's own word beats scattering across three.
 */
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

/**
 * How many word-anchored runs an initialism may be made of.
 *
 * Four covers every real case — `vsc` → Visual Studio Code, `gimp` → GNU Image
 * Manipulation Program — and stops the shape from degenerating into "one letter
 * per word of a long description", which is how a `Keywords=` line full of
 * semicolon-separated terms matches almost anything.
 */
const MAX_ANCHORED_RUNS = 4

/**
 * A match in two pieces is allowed, but only if the pieces are near each other:
 * `ff` → `Firefox` spans five characters, and that is the shape being permitted.
 * Without the span bound this rule would re-admit exactly what the anchoring
 * rule exists to reject.
 */
const MAX_LOOSE_RUNS = 2
const LOOSE_SPAN_SLACK = 3

/** Charged per edit on the typo path, so a repaired match never beats a real one. */
const PENALTY_TYPO = 60

/** Below this length a typo is indistinguishable from a different word. */
const TYPO_MIN_LENGTH = 4

/** `[search].typos` when the caller names none. */
export const DEFAULT_MAX_TYPOS = 1

/** The most `[search].typos` may ask for. Past this the length rule never lets another edit in anyway. */
export const MAX_TYPOS = 5

const BOUNDARY_CHARS = new Set([' ', '-', '_', '.', '/', '\\', ':', '\t', ';', ',', '(', ')', '[', ']'])

function isBoundary(previous: string | undefined): boolean {
  return previous === undefined || BOUNDARY_CHARS.has(previous)
}

function isCamelTransition(previous: string | undefined, current: string): boolean {
  if (previous === undefined) return false
  return previous === previous.toLowerCase() && previous !== previous.toUpperCase() && current !== current.toLowerCase()
}

/** True where `haystack[at]` begins a word, by either rule. */
function startsWord(haystack: string, at: number): boolean {
  const previous = at === 0 ? undefined : haystack[at - 1]
  return isBoundary(previous) || isCamelTransition(previous, haystack[at] ?? '')
}

/**
 * How a token may match, per field.
 *
 * `fuzzy` is the full treatment above, and belongs to fields the user is
 * actually typing at — the name, the generic name.
 *
 * `word` accepts only a run that starts a word. It exists for `Keywords=`,
 * `Comment=` and `Exec=`: prose and semicolon-separated term lists are long
 * enough that *any* subsequence rule finds something, so they get no subsequence
 * rule at all. Typing `browser` still finds Firefox through its keywords;
 * typing `raycast` no longer finds a drawing program through its.
 */
export type FieldMode = 'fuzzy' | 'word'

interface TokenMatch {
  readonly positions: readonly number[]
  readonly typos: number
}

/** One whitespace-separated piece of the needle, with its lowered form kept. */
interface Token {
  readonly text: string
  readonly lower: string
}

/** What a caller may switch off. See {@link fuzzyMatch}. */
export interface MatchOptions {
  /**
   * Whether a token that matched nothing may be repaired by one edit.
   *
   * Defaults to `true`. A caller that scores a large index turns it off for the
   * first pass and back on for a second one, run only when the first found
   * nothing worth showing — a repaired match loses to every strict one, so
   * repairing thousands of candidates that a strict match outranks is work
   * whose result is discarded.
   */
  readonly allowTypos?: boolean
  /**
   * The most edits one token may need, `[search].typos`. Defaults to
   * {@link DEFAULT_MAX_TYPOS}. Each edit still has to be earned by length: see
   * {@link typoBudget}.
   */
  readonly maxTypos?: number
}

/** Contiguous groups of matched positions. */
function runsOf(positions: readonly number[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = []
  for (const at of positions) {
    const last = runs[runs.length - 1]
    if (last !== undefined && at === last.end + 1) last.end = at
    else runs.push({ start: at, end: at })
  }
  return runs
}

/**
 * The gate. See the module header — this is the whole reason a launcher's
 * matcher is not just a subsequence test.
 */
function isAcceptable(positions: readonly number[], haystack: string, token: string): boolean {
  const runs = runsOf(positions)
  if (runs.length <= 1) return true

  if (runs.length <= MAX_ANCHORED_RUNS && runs.every((run) => startsWord(haystack, run.start))) {
    return true
  }

  const first = runs[0]
  const last = runs[runs.length - 1]
  if (first === undefined || last === undefined) return false
  const span = last.end - first.start + 1
  return runs.length <= MAX_LOOSE_RUNS && span <= token.length + LOOSE_SPAN_SLACK
}

/**
 * The two alignments of `token` in `haystack` worth considering, earliest first.
 *
 * Greedy forward proves a match exists at all. A backward pass then pulls each
 * character as late as it can go without crossing its successor — which is what
 * finds the initialism: for "vsc" the greedy pass takes the `s` inside `Visual`
 * and lands on a shape nothing would accept, while the tightened one lands on
 * `**V**isual **S**tudio **C**ode`.
 *
 * Both are returned rather than only the tightened one, because tightening is
 * not monotonically better: for "libre" against `LibreOffice Calc` it drags the
 * `e` onto the one in `Offic**e**`, splitting a clean five-character run into two
 * pieces eleven characters apart. The caller keeps whichever alignment is both
 * acceptable and scores highest, so neither pass has to be right on its own.
 */
function alignments(token: Token, haystack: string, lowerHaystack: string, from: number): number[][] {
  const lowerToken = token.lower

  const greedy: number[] = []
  let cursor = from
  for (const char of lowerToken) {
    const found = lowerHaystack.indexOf(char, cursor)
    if (found === -1) return []
    greedy.push(found)
    cursor = found + 1
  }

  const tightened = [...greedy]
  for (let i = tightened.length - 1; i >= 0; i -= 1) {
    const limit = i === tightened.length - 1 ? haystack.length - 1 : (tightened[i + 1] ?? 0) - 1
    const target = lowerToken[i] ?? ''
    for (let j = limit; j > (tightened[i] ?? 0); j -= 1) {
      if (lowerHaystack[j] === target) {
        tightened[i] = j
        break
      }
    }
  }

  const same = tightened.every((at, i) => at === greedy[i])
  return same ? [greedy] : [greedy, tightened]
}

/** The first word-anchored contiguous run of `token`, at or after `from`. */
function wordAnchored(token: Token, haystack: string, lowerHaystack: string, from: number): number[] | null {
  const lowerToken = token.lower

  for (let at = lowerHaystack.indexOf(lowerToken, from); at !== -1; at = lowerHaystack.indexOf(lowerToken, at + 1)) {
    if (!startsWord(haystack, at)) continue
    return Array.from({ length: token.text.length }, (_, i) => at + i)
  }
  return null
}

/**
 * Word spans of the haystack, lowered, for the typo pass to compare against.
 *
 * The offsets index the original text, because that is what the caller reports
 * as matched positions. The word itself is sliced out of the lowered copy where
 * the two line up character for character, and lowered on its own where they do
 * not — the boundary characters are all case-free, so the spans are the same
 * either way.
 */
function wordsOf(haystack: string, lowerHaystack: string): { text: string; at: number }[] {
  const aligned = lowerHaystack.length === haystack.length
  const words: { text: string; at: number }[] = []
  let start = 0
  for (let at = 0; at <= haystack.length; at += 1) {
    const boundary = at === haystack.length || BOUNDARY_CHARS.has(haystack[at] ?? '')
    if (!boundary) continue
    if (at > start) {
      const text = aligned ? lowerHaystack.slice(start, at) : haystack.slice(start, at).toLowerCase()
      words.push({ text, at: start })
    }
    start = at + 1
  }
  return words
}

/**
 * Damerau-Levenshtein, abandoned as soon as it exceeds `max`.
 *
 * Transpositions are the reason this is Damerau and not plain Levenshtein:
 * `racyast` for `raycast` is two adjacent letters swapped, which is one edit
 * here and two under Levenshtein — and one edit is the entire budget, so the
 * commonest typo of all would never match without it.
 */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1

  let previous2: number[] = []
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current: number[] = []

  for (let i = 1; i <= a.length; i += 1) {
    current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previous2[j - 2] ?? 0) + 1)
      }
      current[j] = value
      if (value < best) best = value
    }
    // Every remaining row can only add to the minimum on this one.
    if (best > max) return max + 1
    previous2 = previous
    previous = current
  }

  return previous[b.length] ?? max + 1
}

/**
 * Edits allowed for a token of this length. Short words get none — one edit on
 * a three-character token matches half the dictionary — and everything else
 * gets **one** by default: `1passwrod` is `1Password` mistyped, but at two
 * edits the token has usually stopped being a typo and started being a
 * different word, and repairing it would only produce guesses.
 *
 * `[search].typos` raises the ceiling, but every extra edit is paid for in
 * length: one per four characters typed, so a second edit needs eight and a
 * third twelve. Two edits on a five-letter token would match most of the
 * dictionary whatever the setting says.
 */
function typoBudget(length: number, maxTypos: number): number {
  return Math.min(maxTypos, Math.floor(length / TYPO_MIN_LENGTH))
}

/**
 * The typo fallback: the closest whole word, if one is close enough.
 *
 * Whole words only, and only when the strict path found nothing. Matching a
 * *prefix* of a longer word is deliberately allowed — someone typing `libreofic`
 * means `LibreOffice` — but matching a fragment in the middle is not.
 */
function typoMatch(
  token: Token,
  haystack: string,
  lowerHaystack: string,
  from: number,
  maxTypos: number
): TokenMatch | null {
  const budget = typoBudget(token.text.length, maxTypos)
  if (budget <= 0) return null

  const lowerToken = token.lower
  let best: TokenMatch | null = null

  for (const word of wordsOf(haystack, lowerHaystack)) {
    if (word.at < from) continue
    const lowerWord = word.text

    // Against the whole word, and against its first `token.length` characters so
    // a typo inside a long name is still recognised.
    const candidates =
      lowerWord.length > lowerToken.length
        ? [lowerWord, lowerWord.slice(0, lowerToken.length)]
        : [lowerWord]

    for (const candidate of candidates) {
      const distance = boundedDistance(lowerToken, candidate, budget)
      if (distance > budget || distance === 0) continue
      if (best !== null && distance >= best.typos) continue
      best = {
        positions: Array.from({ length: candidate.length }, (_, i) => word.at + i),
        typos: distance
      }
    }
  }

  return best
}

function matchToken(
  token: Token,
  haystack: string,
  lowerHaystack: string,
  from: number,
  mode: FieldMode,
  allowTypos: boolean,
  maxTypos: number
): TokenMatch | null {
  if (mode === 'word') {
    const anchored = wordAnchored(token, haystack, lowerHaystack, from)
    return anchored === null ? null : { positions: anchored, typos: 0 }
  }

  let best: number[] | null = null
  let bestScore = -Infinity
  for (const positions of alignments(token, haystack, lowerHaystack, from)) {
    if (!isAcceptable(positions, haystack, token.text)) continue
    const score = scorePositions(positions, haystack)
    if (score <= bestScore) continue
    best = positions
    bestScore = score
  }
  if (best !== null) return { positions: best, typos: 0 }

  return allowTypos ? typoMatch(token, haystack, lowerHaystack, from, maxTypos) : null
}

/**
 * The needle, split into tokens and lowered — remembered for the last needle
 * asked about.
 *
 * One keystroke scores the same needle against every field of every candidate,
 * so splitting and lowering it per call is thousands of repetitions of one
 * answer. A single slot is enough: the calls arrive in bursts of one needle, and
 * a cache that holds more would only hold what the next keystroke invalidates.
 */
let lastNeedle = ''
let lastTokens: readonly Token[] = []

function tokensOf(needle: string): readonly Token[] {
  if (needle === lastNeedle) return lastTokens
  lastNeedle = needle
  lastTokens = needle
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((text) => ({ text, lower: text.toLowerCase() }))
  return lastTokens
}

/**
 * The haystack, lowered once per call rather than once per token.
 *
 * A precomputed copy is trusted only when it lines up character for character
 * with the original: matched positions index the original text, and lowering is
 * not length-preserving in every script.
 */
function loweredOf(haystack: string, lower: string | undefined): string {
  return lower !== undefined && lower.length === haystack.length ? lower : haystack.toLowerCase()
}

/**
 * Score `token`'s positions against `haystack`. Returns `null` when the needle's
 * characters do not all appear in an acceptable shape — the common case, and the
 * reason this returns early rather than scoring first and thresholding after.
 *
 * An empty needle matches everything with score 0, so an empty query leaves
 * ranking entirely to frecency.
 *
 * A needle with spaces is matched **token by token, in order**: "libre calc"
 * asks for a word starting `libre` and then a later one starting `calc`, which
 * is what someone typing two words means. Scoring the space as a character
 * instead would make the second token's run start mid-word and lose its
 * word-start bonus.
 */
export function fuzzyMatch(
  needle: string,
  haystack: string,
  mode: FieldMode = 'fuzzy',
  options?: MatchOptions
): FuzzyMatch | null {
  return scoreTokens(
    tokensOf(needle),
    haystack,
    loweredOf(haystack, undefined),
    mode,
    options?.allowTypos !== false,
    options?.maxTypos ?? DEFAULT_MAX_TYPOS
  )
}

/**
 * {@link fuzzyMatch} with the per-needle and per-haystack work already done, so
 * a caller scoring many fields pays for neither twice.
 */
function scoreTokens(
  tokens: readonly Token[],
  haystack: string,
  lowerHaystack: string,
  mode: FieldMode,
  allowTypos: boolean,
  maxTypos: number
): FuzzyMatch | null {
  if (tokens.length === 0) {
    return { score: 0, positions: [], typos: 0, tier: TIER.PREFIX, at: 0 }
  }
  if (haystack.length === 0) return null

  const positions: number[] = []
  let typos = 0
  let from = 0

  for (const token of tokens) {
    const match = matchToken(token, haystack, lowerHaystack, from, mode, allowTypos, maxTypos)
    if (match === null) return null
    positions.push(...match.positions)
    typos += match.typos
    from = (match.positions[match.positions.length - 1] ?? from) + 1
  }

  const at = positions[0] ?? 0

  return {
    score: scorePositions(positions, haystack) - PENALTY_TYPO * typos,
    positions,
    typos,
    // A repaired match never claims to be a name match of any strength: "fire"
    // onto "File" is a guess, not an answer to the same question, and letting it
    // into a name tier would put it above rows that really do match.
    tier:
      typos > 0
        ? TIER.TYPO
        : at === 0
          ? TIER.PREFIX
          : startsWord(haystack, at)
            ? TIER.WORD_START
            : TIER.NAME_ELSEWHERE,
    at
  }
}

function scorePositions(positions: readonly number[], haystack: string): number {
  let score = 0
  let consecutive = 0

  for (let i = 0; i < positions.length; i += 1) {
    const at = positions[i] ?? 0
    score += SCORE_MATCH

    const previous = at === 0 ? undefined : haystack[at - 1]
    const current = haystack[at] ?? ''

    if (at === 0) {
      score += BONUS_FIRST_CHAR + BONUS_BOUNDARY
    } else if (isBoundary(previous)) {
      score += BONUS_BOUNDARY
    } else if (isCamelTransition(previous, current)) {
      score += BONUS_CAMEL
    }

    if (i > 0) {
      const previousAt = positions[i - 1] ?? -1
      const gap = at - previousAt - 1

      if (gap === 0) {
        consecutive += 1
        // Growing rather than flat: a four-character run should beat two
        // two-character runs, which is what makes prefix matches dominate.
        score += BONUS_CONSECUTIVE * consecutive
      } else {
        consecutive = 0
        score -= PENALTY_GAP_START + PENALTY_GAP_EXTENSION * (gap - 1)
      }
    }

  }

  const first = positions[0] ?? 0
  score -= Math.min(first * PENALTY_LEADING, MAX_LEADING_PENALTY)

  // Length tie-break, deliberately tiny and deliberately not a ratio: a ratio
  // makes long names unrankable rather than merely less preferred.
  score -= Math.min(haystack.length / 40, 4)

  return score
}

export interface FieldMatch extends FuzzyMatch {
  readonly field: string
}

export interface Field {
  readonly name: string
  readonly text: string
  readonly weight: number
  /**
   * `text`, lowered, where the caller holds an index it can build this on.
   *
   * Purely an optimisation, and ignored unless it is the same length as `text`,
   * since matched positions index `text` itself.
   */
  readonly lower?: string
  /** Defaults to `fuzzy`. See {@link FieldMode}. */
  readonly mode?: FieldMode
  /**
   * Whether this field *is* the thing's name.
   *
   * Exactly one field per candidate should set it. Everything else — the generic
   * name, the keywords, the command line — is a way of *finding* the thing, and
   * a match there is reported as {@link TIER.NOT_NAME} however well it scores.
   */
  readonly isName?: boolean
}

/**
 * Score a needle against several fields, keeping the best.
 *
 * "Best" is by **tier first**, then by score. A name match always beats a
 * keyword match, however good the keyword match looks: typing `draw` returned
 * Pinta above nothing useful because its `Keywords=` line begins
 * `draw;drawing;paint;`, which is a perfect prefix match — of a keyword. The
 * launcher's job there is LibreOffice Draw, and Pinta is what you get when you
 * type `pinta`.
 *
 * Positions come back only for the field that won, and the caller is told which
 * one — highlighting a keyword match inside the display name would draw ranges
 * that do not correspond to the text on screen.
 */
export function matchFields(
  needle: string,
  fields: readonly Field[],
  options?: MatchOptions
): FieldMatch | null {
  const tokens = tokensOf(needle)
  const allowTypos = options?.allowTypos !== false
  const maxTypos = options?.maxTypos ?? DEFAULT_MAX_TYPOS
  let best: FieldMatch | null = null

  for (const field of fields) {
    const match = scoreTokens(
      tokens,
      field.text,
      loweredOf(field.text, field.lower),
      field.mode ?? 'fuzzy',
      allowTypos,
      maxTypos
    )
    if (match === null) continue

    // A non-name field can only ever be `NOT_NAME` — or `TYPO`, which is worse
    // still and stays worse.
    const tier =
      field.isName === true || match.tier === TIER.TYPO ? match.tier : TIER.NOT_NAME
    const weighted = match.score * field.weight
    if (best !== null && (tier > best.tier || (tier === best.tier && weighted <= best.score))) {
      continue
    }
    best = {
      score: weighted,
      positions: match.positions,
      typos: match.typos,
      tier,
      at: match.at,
      field: field.name
    }
  }

  return best
}
