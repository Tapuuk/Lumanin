import { all, create, type FactoryFunctionMap, type MathJsInstance } from 'mathjs'

/**
 * The inline calculator.
 *
 * Two problems, and the second is the hard one:
 *
 *  1. Evaluate an expression, including units — `10 km to miles`, `3 GB / 4`.
 *     mathjs does this, which is why CLAUDE.md picked it.
 *  2. **Know when not to.** This runs on every keystroke alongside the app
 *     search, so it has to stay silent for `7-zip`, `gimp 2.10` and `python3`,
 *     all of which are perfectly good arithmetic-shaped strings. A calculator
 *     row that appears while you are typing an application name is worse than no
 *     calculator at all.
 *
 * The answer to (2) is a deliberately narrow gate *before* mathjs is asked
 * anything: the query must contain a digit, must contain something that makes it
 * an operation rather than a value, and must not contain a bare word that is not
 * a unit or function mathjs knows. Anything that gets through and then fails to
 * evaluate yields nothing, silently — an exception here is a normal outcome, not
 * an error.
 */

/**
 * A restricted mathjs instance.
 *
 * `evaluate` on a full mathjs is a small programming language: it can define
 * functions and variables, and `import`/`createUnit` can reach the host. Nothing
 * we want a launcher's search bar to do. mathjs's own security guidance is to
 * remove exactly these, so they are removed rather than trusted not to be
 * reached — the input is whatever the user typed, which is the definition of
 * untrusted for SECURITY.md's purposes.
 */
function restricted(): {
  evaluate: (expression: string) => unknown
  simplify: (expression: string) => string
  format: (value: unknown, options: { precision: number }) => string
  isUnit: (name: string) => boolean
  known: (name: string) => boolean
} {
    // `all` is typed as possibly-undefined because mathjs ships partial bundles
  // too; this build imports the full one, so the cast documents that rather than
  // a `!` hiding it.
  const math: MathJsInstance = create(all as FactoryFunctionMap)

  // Captured *before* the override, and this is the whole trick: overriding
  // `evaluate` replaces the same binding we would otherwise call, so disabling it
  // naively disables the calculator along with the attack. Holding the original
  // means expressions still evaluate, while a call to `evaluate(…)` *inside* an
  // expression resolves to the throwing one.
  const evaluate = math.evaluate.bind(math)
  // Same capture for `simplify`: it is what answers `2x + 3x` when `x` is a
  // variable rather than a value, and inside an expression it stays disabled.
  const simplify = math.simplify.bind(math)
  const format = math.format.bind(math)
  const isUnit = (name: string): boolean => {
    try {
      return math.Unit.isValuelessUnit(name)
    } catch {
      return false
    }
  }
  const known = (name: string): boolean => {
    const value = (math as unknown as Record<string, unknown>)[name]
    return typeof value === 'function' || typeof value === 'number'
  }

  math.import(
    {
      import: function forbidden(): never {
        throw new Error('disabled')
      },
      createUnit: function forbidden(): never {
        throw new Error('disabled')
      },
      evaluate: function forbidden(): never {
        throw new Error('disabled')
      },
      parse: function forbidden(): never {
        throw new Error('disabled')
      },
      simplify: function forbidden(): never {
        throw new Error('disabled')
      },
      derivative: function forbidden(): never {
        throw new Error('disabled')
      }
    },
    { override: true }
  )

  return {
    evaluate,
    simplify: (expression) => simplify(expression).toString(),
    format: (value, options) => format(value, options),
    isUnit,
    known
  }
}

const math = restricted()

export interface CalculationResult {
  /** The expression as typed, trimmed. */
  readonly expression: string
  /** The formatted answer — what gets copied when the user presses Enter. */
  readonly value: string
}

/** Characters that can appear in an expression we are willing to try. */
const PLAUSIBLE = /^[\d\s+\-*/^%().,:!<>=|&a-zA-Z°'"×÷·−√π]+$/

/** Something that makes this an *operation* rather than a value typed at us. */
const IS_OPERATION = /[+\-*/^%]|\b(to|in|mod)\b|\w\s*\(/i

/**
 * Words that make a query an application name rather than a sum.
 *
 * The gate cannot be "contains no letters" — units and functions are letters, and
 * `10 km to miles` is the feature. So instead: every bare word has to be
 * something mathjs will recognise. `7-zip` has `zip`, `gimp 2.10` has `gimp`, and
 * both are rejected before mathjs sees them, without a hardcoded list of
 * application names.
 */
function wordsAreKnown(expression: string): boolean {
  const words = expression.match(/[a-zA-Z°]{1,}/g) ?? []

  return words.every((word) => {
    const lower = word.toLowerCase()
    if (lower === 'to' || lower === 'in' || lower === 'mod') return true
    // A single letter may be a variable — `2x + 3x` is desktop-calculator
    // algebra, not an application name. Words of two or more letters keep the
    // strict rule; that is what rejects `gimp`, `zip` and `firefox`.
    if (word.length === 1) return true
    try {
      // `isUnit` covers `km`, `GiB`, `degC`; `known` covers `sqrt`, `pi`, `sin`.
      // Anything else is a word from someone's application name.
      return math.isUnit(word) || math.known(word)
    } catch {
      return false
    }
  })
}

/**
 * What people type for a unit, against what mathjs calls it.
 *
 * mathjs is case-sensitive and, for data, inconsistent about it: `kb` is a
 * kilo*bit*, `mb` and `gb` are nothing at all, and only `MB`/`GB`/`TB` work. So
 * `5 gb in mb` — a thing anyone might type — failed outright, while `5 kb in mb`
 * would have silently mixed bits and bytes.
 *
 * The whole lowercase data family is therefore mapped to **bytes**, `kb`
 * included. That deliberately overrides mathjs's reading of `kb`: in a launcher,
 * someone typing it about a file means kilobytes, and being consistent within
 * one expression matters more than matching a convention nobody outside SI
 * follows. `kbit`/`Mbit` remain the way to ask for bits.
 */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  kb: 'kB',
  mb: 'MB',
  gb: 'GB',
  tb: 'TB',
  pb: 'PB',
  kib: 'KiB',
  mib: 'MiB',
  gib: 'GiB',
  tib: 'TiB',
  kbit: 'kb',
  mbit: 'Mb',
  gbit: 'Gb'
}

/**
 * Temperature, which is the one place a single letter is worth accepting.
 *
 * `c` and `f` are not mathjs units, and their uppercase forms are the *coulomb*
 * and the *farad* — so reading them as temperature can only be done when the
 * whole expression is about temperature. {@link normalize} requires exactly
 * that: every word has to be one of these before any of them is rewritten, so
 * `2 F * 3 s` keeps its farads.
 */
const TEMPERATURE_ALIASES: Readonly<Record<string, string>> = {
  c: 'degC',
  f: 'degF',
  k: 'K',
  degc: 'degC',
  degf: 'degF',
  celsius: 'degC',
  fahrenheit: 'degF',
  kelvin: 'K'
}

/**
 * Rewrite what was typed into what mathjs understands.
 *
 * Only ever a *renaming*: nothing here changes the arithmetic, so a query that
 * would have been rejected still is, and one that already worked is untouched.
 */
function normalize(expression: string): string {
  // The keys a desktop calculator has that a keyboard spells differently:
  // `×`, `÷`, `·`, the typographic minus, `π`, `**` for a power, `√` for a
  // root. All pure renamings into mathjs's spellings.
  let out = expression
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('·', '*')
    .replaceAll('−', '-')
    .replaceAll('π', ' pi ')
    .replaceAll('**', '^')
    // `√9`, `√x`, `√(1+2)` — the paren form only needs the sign renamed.
    .replace(/√\s*(\d+(?:\.\d+)?|[a-zA-Z]+)/g, 'sqrt($1)')
    .replace(/√\s*\(/g, 'sqrt(')

  // `x` as the times key — `2x8`, `2 x 8`, `Xx4` — the way every desktop
  // calculator and half of all chat messages write it. Hex literals are
  // fenced off first: `0x10` is sixteen, not zero times ten.
  const hex: string[] = []
  out = out.replace(/\b0[xX][0-9a-fA-F]+\b/g, (literal) => {
    hex.push(literal)
    return `\u0000${String(hex.length - 1)}\u0000`
  })
  out = out
    // Between digits or against a parenthesis: `2x8`, `3x(1+2)`, `(1+2)x3`.
    .replace(/(?<=[\d)])\s*[xX]\s*(?=[\d(])/g, ' * ')
    // A single-letter variable against the times key: `Xx4` is X times 4.
    .replace(/\b([a-zA-Z])[xX](?=[\d(])/g, '$1 * ')
    .replace(/(?<=[\d)])[xX]([a-zA-Z])\b/g, ' * $1')
    // Standalone between spaces: `pi x 2`.
    .replace(/(?<=[\w)])\s+[xX]\s+(?=[\w(])/g, ' * ')
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => hex[Number(index)] ?? '')

  // `15% of 80`. mathjs already does percentages — `80 + 15%` is 92 — it just has
  // no word for the commonest phrasing of one.
  out = out.replace(/(\d\s*%)\s+of\b/gi, '$1 *')

  const words = out.match(/[a-zA-Z]+/g) ?? []
  const allTemperature =
    words.length > 0 &&
    words.every((word) => {
      const lower = word.toLowerCase()
      return lower === 'to' || lower === 'in' || lower in TEMPERATURE_ALIASES
    })

  out = out.replace(/[a-zA-Z]+/g, (word) => {
    const lower = word.toLowerCase()
    if (lower === 'to' || lower === 'in' || lower === 'mod') return word
    if (allTemperature && lower in TEMPERATURE_ALIASES) return TEMPERATURE_ALIASES[lower] as string
    // A spelling mathjs already knows is never second-guessed.
    if (math.isUnit(word) || math.known(word)) return word
    return UNIT_ALIASES[lower] ?? word
  })

  return out
}

/**
 * Try to read `query` as a calculation. `null` means "this is not one", which is
 * the answer for the overwhelming majority of keystrokes.
 */
export function calculate(query: string): CalculationResult | null {
  const typed = query.trim()

  if (typed.length === 0 || typed.length > 200) return null
  // A digit is required, so `pi` alone does not turn the search bar into a
  // calculator — but `pi * 2` does.
  if (!/\d/.test(typed)) return null
  if (!PLAUSIBLE.test(typed)) return null
  // Assignment is a program, not a sum — and with single-letter variables
  // allowed, `x=5` would otherwise evaluate instead of being refused.
  if (/(?<![<>=!])=(?!=)/.test(typed)) return null

  // Normalised before the gates, not after: `2x8` only reads as an operation
  // once `x` has become `*`, and `5 gb in mb` only survives the word gate once
  // `gb` and `mb` are spellings mathjs recognises.
  const expression = normalize(typed)
  if (!IS_OPERATION.test(expression)) return null
  if (!wordsAreKnown(expression)) return null

  let result: unknown
  try {
    result = math.evaluate(expression)
  } catch {
    // A variable — `2x + 3x`, `Xx4` — is exactly what fails to *evaluate* and
    // still has an answer: the simplified form. Everything else that lands
    // here is a half-typed expression, and stays silent.
    return symbolic(typed, expression)
  }

  // A function, a matrix, or `undefined`: mathjs succeeded at something that is
  // not an answer to show in a launcher.
  if (result === undefined || result === null) return null
  if (typeof result === 'function') return null
  if (typeof result === 'number' && !Number.isFinite(result)) return null

  let value: string
  try {
    // Fixed precision rather than raw: `0.1 + 0.2` should read `0.3`, not
    // `0.30000000000000004`.
    value = math.format(result, { precision: 12 })
  } catch {
    return null
  }

  // `2` evaluating to `2` is not worth a row; it is the user typing a number.
  if (value === typed) return null
  if (value.length > 120) return null

  // The subtitle is what was **typed**, never the normalised form: seeing
  // "5 GB in MB" under an answer you asked for as "5 gb in mb" reads as the
  // launcher having misunderstood you, even when it did not.
  return { expression: typed, value }
}

/**
 * The algebra half: `Xx4` is `4X`, `2x + 3x` is `5x`.
 *
 * Only single-letter variables get here (the word gate holds everything else),
 * so the failure mode of showing algebra for an application name does not
 * exist — the app-shaped words never reach evaluation at all.
 */
function symbolic(typed: string, expression: string): CalculationResult | null {
  // A single-letter run, wherever it sits — `\b` would miss the `x` in `2x`,
  // because the digit beside it is also a word character.
  if (!/(?<![a-zA-Z])[a-zA-Z](?![a-zA-Z])/.test(expression)) return null
  let value: string
  try {
    value = math.simplify(expression)
  } catch {
    return null
  }
  // mathjs spells a term `4 * X`; a person writes `4X`. Only the
  // number-times-variable form is compacted — anything else keeps the
  // explicit operator.
  // Not when a power follows: `3x ^ 2` reads as `(3x)²`, which is not what
  // `3 * x ^ 2` means.
  value = value
    .replace(/\b([a-zA-Z])\s\*\s(\d+(?:\.\d+)?)(?!\s*\^)/g, '$2$1')
    .replace(/(\d+(?:\.\d+)?)\s\*\s([a-zA-Z])(?!\s*\^)\b/g, '$1$2')
  if (value === typed || value === expression) return null
  if (value.length > 120) return null
  return { expression: typed, value }
}
