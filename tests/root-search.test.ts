import { describe, expect, it } from 'vitest'
import { composeRoot, type RootCommand, type ScoredRow } from '../src/main/root-search'
import { TIER, type MatchTier } from '../src/shared/fuzzy'
import { calculate } from '../src/shared/calculator'
import { loadConfig, type ResolvedConfig } from '../src/shared/config'
import type { ResultItem } from '../src/shared/ipc'
import {
  buildSearchUrl,
  isOpenableUrl,
  matchKeyword,
  normalizeSearchTemplate,
  suggestSearchIdentity
} from '../src/shared/websearch'

/**
 * The root list's composition rules, tested without an index or a window: the
 * application rows are an input here, so what is under test is the *ordering*
 * and nothing else.
 */

const COMMANDS: readonly RootCommand[] = [
  {
    id: 'builtin/reload-applications',
    title: 'Reload Applications',
    subtitle: 'Rebuild the application index now',
    keywords: ['rescan', 'reindex']
  },
  {
    id: 'builtin/quit',
    title: 'Quit Lumanin',
    subtitle: 'Stop the daemon',
    keywords: ['exit']
  }
]

const APP: ResultItem = { id: 'app:firefox.desktop', title: 'Firefox', kind: 'app' }

/**
 * Applications arrive pre-scored, because apps and commands are ranked against
 * each other. The score here stands in for whatever the index would have given.
 */
const scored = (
  row: ResultItem,
  score = 100,
  tier: MatchTier = TIER.PREFIX,
  at = 0
): ScoredRow => ({ row, score, tier, at })

function config(file = ''): ResolvedConfig {
  return loadConfig({ fileContents: file, env: {} })
}

function compose(query: string, options: { file?: string; apps?: readonly ScoredRow[] } = {}) {
  return composeRoot({
    query,
    config: config(options.file ?? ''),
    commands: COMMANDS,
    apps: options.apps ?? [],
    resolveAlias: (target) => {
      if (target === 'firefox.desktop') return APP
      const command = COMMANDS.find((candidate) => candidate.id === target)
      return command === undefined
        ? null
        : { id: `command:${command.id}`, title: command.title, kind: 'command' }
    }
  })
}

describe('composeRoot', () => {
  it('shows nothing for an empty query', () => {
    expect(compose('   ')).toEqual([])
  })

  it('ranks a command above an application that merely matches worse', () => {
    // The defect this exists for: with a strict group partition, typing "reload"
    // put LibreOffice Calc above the command called Reload Applications, purely
    // because applications come first in the default order.
    const rows = compose('reload', { apps: [scored({ ...APP, title: 'LibreOffice Calc' }, 40)] })
    expect(rows[0]?.title).toBe('Reload Applications')
  })

  it('still ranks a better application first', () => {
    expect(compose('reload', { apps: [scored(APP, 500)] })[0]?.kind).toBe('app')
  })

  it('leaves out a kind the order does not list', () => {
    // What `fallback_order` still decides once apps and commands are ranked
    // together: which of them is consulted at all.
    const appsOnly = compose('reload', {
      apps: [scored(APP)],
      file: '[search]\nfallback_order = ["apps"]\n'
    })
    expect(appsOnly.every((row) => row.kind === 'app')).toBe(true)

    const commandsOnly = compose('reload', {
      apps: [scored(APP)],
      file: '[search]\nfallback_order = ["commands"]\n'
    })
    expect(commandsOnly.every((row) => row.kind === 'command')).toBe(true)
    expect(commandsOnly.length).toBeGreaterThan(0)
  })

  it('drops a scattered match that is nowhere near the best one', () => {
    // "fire" is a genuine subsequence of "Open Con(f)igurat(i)on Fil(e)", and
    // showing it under Firefox is the kind of noise a relative cutoff exists to
    // remove — but only if the cutoff can see both kinds at once.
    const rows = compose('fire', { apps: [scored(APP, 300)] }).filter((row) => row.kind !== 'web')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Firefox')
  })

  it('puts what starts with the query above what merely contains it', () => {
    // The order asked for, in the user's words: the first results are the ones
    // that start with what you typed, then further and further into the name.
    // Note the scores are deliberately *inverted* — the prefix match scores
    // worse — so this cannot pass by accident.
    const rows = compose('draw', {
      apps: [
        scored({ id: 'app:libre.desktop', title: 'LibreOffice Draw', kind: 'app' }, 300, TIER.WORD_START, 12),
        scored({ id: 'app:drawio.desktop', title: 'Drawio', kind: 'app' }, 100, TIER.PREFIX, 0)
      ]
    }).filter((row) => row.kind === 'app')

    expect(rows.map((row) => row.title)).toEqual(['Drawio', 'LibreOffice Draw'])
  })

  it('drops a keyword match as soon as anything matched by name', () => {
    // The defect this exists for: typing "draw" offered Pinta next to
    // LibreOffice Draw, because Pinta's `Keywords=` begins `draw;drawing;paint;`.
    const rows = compose('draw', {
      apps: [
        scored({ id: 'app:libre.desktop', title: 'LibreOffice Draw', kind: 'app' }, 100, TIER.WORD_START, 12),
        scored({ id: 'app:pinta.desktop', title: 'Pinta', kind: 'app' }, 300, TIER.NOT_NAME, 0)
      ]
    }).filter((row) => row.kind === 'app')

    expect(rows.map((row) => row.title)).toEqual(['LibreOffice Draw'])
  })

  it('still finds things by keyword when nothing is called that', () => {
    // The other half of the rule. "browser" has to keep finding Firefox.
    const rows = compose('browser', {
      apps: [scored({ id: 'app:firefox.desktop', title: 'Firefox', kind: 'app' }, 200, TIER.NOT_NAME, 4)]
    }).filter((row) => row.kind === 'app')

    expect(rows.map((row) => row.title)).toEqual(['Firefox'])
  })

  it('shows a typo repair only when nothing matched exactly', () => {
    // A repair is a guess, and a guess must not take the row from an exact
    // keyword match: "paint" repairs onto "Print Settings" at one edit, and
    // Pinta's keywords really do say `paint`.
    const both = compose('paint', {
      apps: [
        scored({ id: 'app:print.desktop', title: 'Print Settings', kind: 'app' }, 300, TIER.TYPO, 0),
        scored({ id: 'app:pinta.desktop', title: 'Pinta', kind: 'app' }, 100, TIER.NOT_NAME, 13)
      ]
    }).filter((row) => row.kind === 'app')
    expect(both.map((row) => row.title)).toEqual(['Pinta'])

    const alone = compose('racyast', {
      apps: [scored({ id: 'app:ray.desktop', title: 'Raycast', kind: 'app' }, 200, TIER.TYPO, 0)]
    }).filter((row) => row.kind === 'app')
    expect(alone.map((row) => row.title)).toEqual(['Raycast'])
  })

  it('omits a group the user left out entirely — except the calculator', () => {
    // `calculator` stopped being a position (2026-08-11): a query that *is* a
    // calculation has one right answer, so the row shows regardless of the
    // order — while `web`, genuinely left out here, stays gone.
    const rows = compose('2+2', { file: '[search]\nfallback_order = ["apps"]\n' })
    expect(rows.map((row) => row.kind)).toEqual(['calculator'])
  })

  it('always offers a search, whether or not anything else matched', () => {
    // The defect this exists for: the list used to show an application *or* a
    // web search depending on which heuristic fired, so reaching the other one
    // meant retyping the query.
    expect(compose('zzzz').every((row) => row.kind === 'web')).toBe(true)

    // Scored comparably to the command, so the relative cutoff keeps both: the
    // claim under test is that all three kinds coexist, not that the cutoff is
    // gone.
    const matched = compose('reload', { apps: [scored(APP, 200)] })
    expect(matched.some((row) => row.kind === 'app')).toBe(true)
    expect(matched.some((row) => row.kind === 'command')).toBe(true)
    expect(matched.some((row) => row.kind === 'web')).toBe(true)
  })

  it('offers every engine the user enabled, and only those', () => {
    const rows = compose('wayland', { file: '[search]\nengines = ["ddg", "archwiki"]\n' })
    const searches = rows.filter((row) => row.kind === 'web').map((row) => row.title)

    expect(searches).toEqual([
      'Search DuckDuckGo for “wayland”',
      'Search Arch Wiki for “wayland”'
    ])
  })

  it('puts the searches last by default, under whatever matched', () => {
    const rows = compose('reload', { apps: [scored(APP, 500)] })
    expect(rows.at(-1)?.kind).toBe('web')
  })

  it('offers no search when the user enabled none', () => {
    const rows = compose('wayland', { file: '[search]\nengines = []\n' })
    expect(rows).toEqual([])
  })

  it('lets a keyword search jump the queue, because the user named it', () => {
    const rows = compose('g reload applications', { apps: [scored(APP)] })
    expect(rows[0]?.kind).toBe('web')
    expect(rows[0]?.id).toContain('reload%20applications')
    // …and the rest of the list is still there underneath. Note the other groups
    // still search the *whole* query, keyword and all: someone typing `g` may be
    // reaching for an application whose name starts with it.
    expect(rows.some((row) => row.kind === 'app')).toBe(true)
  })

  it('does not treat a bare keyword as a search', () => {
    // `g` alone is someone typing the first letter of an application, not a
    // request to search for nothing.
    expect(compose('g', { apps: [scored(APP)] })[0]?.kind).toBe('app')
  })

  it('puts an exact alias first', () => {
    const rows = compose('rl', {
      apps: [scored(APP)],
      file: '[aliases]\nrl = "builtin/reload-applications"\n'
    })
    expect(rows[0]?.id).toBe('command:builtin/reload-applications')
  })

  it('matches an alias exactly, never fuzzily', () => {
    // An alias is a shortcut someone memorised. A fuzzy one is just another
    // search result that occasionally surprises you.
    const rows = compose('rlx', { file: '[aliases]\nrl = "builtin/quit"\n' })
    expect(rows.some((row) => row.id === 'command:builtin/quit')).toBe(false)
  })

  it('ignores an alias whose target no longer exists', () => {
    const rows = compose('gone', { file: '[aliases]\ngone = "builtin/removed"\n' })
    expect(rows.every((row) => row.kind === 'web')).toBe(true)
  })

  it('never repeats a row that two rules both produced', () => {
    const rows = compose('rl', { file: '[aliases]\nrl = "builtin/reload-applications"\n' })
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })

  it('puts the calculation above everything, wherever the order put it', () => {
    // Nobody types 24/8 hoping for an application: the calculator ignores the
    // order entirely and always comes first, with the ever-present web rows
    // wherever the config placed them.
    const rows = compose('24/8', { file: '[search]\nfallback_order = ["web", "apps"]\n' })
    expect(rows[0]?.kind).toBe('calculator')
    expect(rows[0]?.title).toBe('3')
    expect(rows.slice(1).every((row) => row.kind === 'web')).toBe(true)
  })

  it('carries the expression as the calculation subtitle', () => {
    const [row] = compose('2+2*3')
    expect(row?.title).toBe('8')
    expect(row?.subtitle).toBe('2+2*3')
    expect(row?.id).toBe('calculator:8')
  })
})

/**
 * The `plugins` group, which exists for one measurable reason: ranked in with
 * the applications, a plugin named after the thing it searches always lost to
 * the application of that name, so reaching it cost an arrow key every time.
 */
describe('the plugins group', () => {
  const GODOT_APP: ResultItem = { id: 'app:godot.desktop', title: 'Godot Engine', kind: 'app' }
  const WITH_PLUGIN: readonly RootCommand[] = [
    ...COMMANDS,
    {
      id: 'godot/search',
      title: 'Search Godot Projects',
      subtitle: 'Godot',
      keywords: [],
      kind: 'extension',
      extensionTitle: 'Godot',
      categories: [{ id: 'project', title: 'Project' }]
    }
  ]

  const composeWith = (query: string, file = ''): readonly ResultItem[] =>
    composeRoot({
      query,
      config: config(file),
      commands: WITH_PLUGIN,
      // A prefix match on the application, which is what used to win.
      apps: [scored(GODOT_APP, 120, TIER.PREFIX, 0)],
      resolveAlias: () => null
    })

  it('puts a plugin’s command above the application of the same name, by default', () => {
    const rows = composeWith('godot')
    expect(rows[0]?.id).toBe('extension:godot/search')
    expect(rows[1]?.id).toBe('app:godot.desktop')
  })

  it('follows the order when it is moved, rather than being hard-coded first', () => {
    const rows = composeWith('godot', '[search]\norder = ["apps", "commands", "plugins", "web"]\n')
    expect(rows[0]?.id).toBe('app:godot.desktop')
    expect(rows[1]?.id).toBe('extension:godot/search')
  })

  it('drops plugin rows entirely from an order that leaves the group out', () => {
    const rows = composeWith('godot', '[search]\norder = ["apps", "commands"]\n')
    expect(rows.some((row) => row.kind === 'extension')).toBe(false)
  })

  it('is still held to the score floor — it is a group, not an exemption', () => {
    expect(composeWith('zzzz').some((row) => row.kind === 'extension')).toBe(false)
  })

  it('does not let a keyword match on a plugin beat a name match on an app', () => {
    // The regression that arrived the day we started shipping a plugin by
    // default. `plugins` is first in the order, and the group's score cutoff was
    // applied per group — so a plugin found by a scattered subsequence of its
    // *manifest keywords* went above an application found by its **name**.
    // Typing "fire" offered "Search Files" above Firefox.
    //
    // Plugins-first was decided for "godot" meaning the projects list rather
    // than the editor: one strong match beating another strong match. It was
    // never a licence for a weak one to win.
    const rows = composeRoot({
      query: 'fire',
      config: config(''),
      commands: [
        ...COMMANDS,
        {
          id: 'files/search',
          title: 'Search Files',
          subtitle: 'Files',
          // f‑i‑r‑e really is in there, in order, across these words.
          keywords: ['file', 'find', 'directory', 'locate'],
          kind: 'extension',
          extensionTitle: 'Files'
        }
      ],
      apps: [
        scored({ id: 'app:firefox.desktop', title: 'Firefox', kind: 'app' }, 120, TIER.PREFIX, 0)
      ],
      resolveAlias: () => null
    })

    expect(rows[0]?.id).toBe('app:firefox.desktop')
    expect(rows.some((row) => row.id === 'extension:files/search')).toBe(false)
  })

  it('still puts the plugin first when both were found by name', () => {
    // The other half of the same rule: "how it was found" is compared across the
    // two groups, so an equally-good match keeps the position the order gives it.
    const rows = composeRoot({
      query: 'file',
      config: config(''),
      commands: [
        ...COMMANDS,
        {
          id: 'files/search',
          title: 'Search Files',
          subtitle: 'Files',
          keywords: [],
          kind: 'extension',
          extensionTitle: 'Files'
        }
      ],
      apps: [scored({ id: 'app:files.desktop', title: 'Files', kind: 'app' }, 120, TIER.PREFIX, 0)],
      resolveAlias: () => null
    })

    expect(rows[0]?.id).toBe('extension:files/search')
    expect(rows[1]?.id).toBe('app:files.desktop')
  })

  it('judges a plugin’s rows against each other, not against the best application', () => {
    // The application scores 120 on a prefix match; the plugin's own name match
    // is weaker. Sharing one relative cutoff is what used to delete it.
    const rows = composeWith('search godot')
    expect(rows.some((row) => row.id === 'extension:godot/search')).toBe(true)
  })
})

describe('pins', () => {
  const PINNED = '[search]\npins = ["command:builtin/quit"]\n'

  it('hoists a pinned row above a better-scoring one', () => {
    // "quit" matches the command; the application is deliberately given the
    // higher score, so only the pin can explain the order.
    const rows = compose('quit', { file: PINNED, apps: [scored(APP, 900)] })
    expect(rows[0]?.id).toBe('command:builtin/quit')
  })

  it('keeps a pinned row that the cutoff would have dropped', () => {
    // A pin is a standing instruction to keep something visible. Letting the
    // relative cutoff remove it would make pinning work only for rows that did
    // not need it.
    const rows = compose('quit', { file: PINNED, apps: [scored(APP, 5000)] })
    expect(rows.some((row) => row.id === 'command:builtin/quit')).toBe(true)
  })

  it('does not conjure a pinned row that has nothing to do with the query', () => {
    // Pinning reorders what matched; it is not a second, permanent list.
    expect(compose('firefox', { file: PINNED, apps: [scored(APP)] }).some(
      (row) => row.id === 'command:builtin/quit'
    )).toBe(false)
  })

  it('shows the pins, and nothing else, before anything is typed', () => {
    const rows = compose('', { file: PINNED })
    expect(rows.map((row) => row.id)).toEqual(['command:builtin/quit'])
  })

  it('leaves the root empty when nothing is pinned', () => {
    // The panel's layout is built around opening as a bare search bar. That
    // promise still holds for everyone who has not asked otherwise.
    expect(compose('')).toEqual([])
  })

  it('skips a pinned search at the root, having nothing to search for', () => {
    const rows = compose('', { file: '[search]\npins = ["web:google"]\n' })
    expect(rows).toEqual([])
  })

  it('puts a pinned search at the top, where a search would otherwise be last', () => {
    // The one pin that needs no match: searching for what was typed is always
    // something the launcher can do.
    const rows = compose('reload', { file: '[search]\npins = ["web:google"]\n' })
    expect(rows[0]?.kind).toBe('web')
    expect(rows.filter((row) => row.kind === 'web')).toHaveLength(1)
  })

  it('cannot re-enable a group the order leaves out', () => {
    const rows = compose('reload', {
      file: '[search]\norder = ["commands"]\npins = ["web:google"]\n'
    })
    expect(rows.every((row) => row.kind === 'command')).toBe(true)
  })

  it('lets a keyword override a pinned search, having named the engine', () => {
    const rows = compose('g wayland', {
      file: '[search]\nengines = ["google", "ddg"]\npins = ["web:ddg"]\n'
    })
    expect(rows.map((row) => row.title)).toEqual(['Search Google for “wayland”'])
  })

  it('rejects a pin that is not a <kind>:<id> key, and says so', () => {
    // Reported rather than dropped in silence: a typo'd pin is invisible by
    // definition — it simply never appears — so `doctor` has to be able to
    // answer "I pinned that and it didn't show up".
    const rejected = config('[search]\npins = ["builtin/quit", "nonsense"]\n')
    expect(rejected.search.pins.value).toEqual([])
    expect(rejected.problems).toHaveLength(2)
  })
})

describe('per-query rules', () => {
  const RULE = `
[search]
pins = []

[[search.rules]]
match = "1password"
first = ["command:builtin/quit", "app:firefox.desktop"]
`

  it('injects the named rows, in the order the rule names them', () => {
    // Neither of these matches "1password" at all — that is the point. A rule is
    // how someone overrules the ranking for a query they type every day.
    const rows = compose('1password', { file: RULE })
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual([
      'command:builtin/quit',
      'app:firefox.desktop'
    ])
  })

  it('fires once enough of the trigger is typed', () => {
    expect(compose('1pa', { file: RULE })[0]?.id).toBe('command:builtin/quit')
    // …but not from a single character, or typing "1" would rearrange the list
    // on the strength of a guess.
    expect(compose('1', { file: RULE })[0]?.id).not.toBe('command:builtin/quit')
  })

  it('still fires when the query continues past the trigger', () => {
    expect(compose('1password vault', { file: RULE })[0]?.id).toBe('command:builtin/quit')
  })

  it('leaves other queries alone', () => {
    expect(compose('reload', { file: RULE })[0]?.title).toBe('Reload Applications')
  })

  it('can override the group order for its query only', () => {
    const file = `
[[search.rules]]
match = "calc"
order = ["web"]
`
    expect(compose('calc', { file, apps: [scored(APP)] }).every((row) => row.kind === 'web')).toBe(
      true
    )
    expect(compose('reload', { file }).some((row) => row.kind === 'command')).toBe(true)
  })
})

describe('calculate', () => {
  it.each([
    ['2+2', '4'],
    ['0.1+0.2', '0.3'],
    ['2^10', '1024'],
    ['(3+4)*2', '14'],
    ['sqrt(16)', '4'],
    ['10 km to miles', '6.21371192237 miles'],
    ['90 degC in degF', '194 degF'],
    ['1 day in hours', '24 hours'],
    ['3 GB / 4', '0.75 GB']
  ])('%s = %s', (input, expected) => {
    expect(calculate(input)?.value).toBe(expected)
  })

  it.each([
    // Every one of these is a plausible thing to type at a launcher, and every
    // one is arithmetic-shaped enough to fool a naive gate.
    '7-zip',
    'gimp 2.10',
    'python3',
    'vlc 3.0.18',
    'node 20',
    'firefox',
    'libre 3',
    '2',
    'fire'
  ])('stays silent for %s', (input) => {
    expect(calculate(input)).toBeNull()
  })

  it.each([
    // mathjs is case-sensitive and, for data, inconsistent about it: `kb` is a
    // kilo*bit*, `mb` and `gb` are nothing at all. Every one of these is a thing
    // a person types, and every one returned nothing before.
    ['5 gb in mb', '5000 MB'],
    ['500 kb in mb', '0.0625 MB'],
    ['2 gib in mb', '2147.483648 MB'],
    ['100 f to c', '37.7777777778 degC'],
    ['20 c in f', '68 degF'],
    ['300 k in c', '26.85 degC'],
    // mathjs already does percentages; it just has no word for the commonest
    // phrasing of one.
    ['15% of 80', '12'],
    ['80 + 15%', '92']
  ])('understands %s', (input, expected) => {
    expect(calculate(input)?.value).toBe(expected)
  })

  it.each([
    // The keys a desktop calculator has: `x` as times, `×`, `÷`, `·`, `√`,
    // `π`, `**` — and half of all chat messages write multiplication as `x`.
    ['2x8', '16'],
    ['2 x 8', '16'],
    ['100 x 5', '500'],
    ['3×3', '9'],
    ['9÷3', '3'],
    ['2·3', '6'],
    ['√9', '3'],
    ['√(16+9)', '5'],
    ['2**8', '256'],
    ['π*2', '6.28318530718'],
    ['pi x 2', '6.28318530718'],
    // Hex survives the `x` rewrite: `0x10` is sixteen, not zero times ten.
    ['0x10+2', '18']
  ])('reads the desktop-calculator spelling %s as %s', (input, expected) => {
    expect(calculate(input)?.value).toBe(expected)
  })

  it.each([
    // Algebra with a single-letter variable: what fails to evaluate still has
    // an answer — the simplified form, compacted the way a person writes it.
    ['Xx4', '4X'],
    ['2x + 3x', '5x'],
    ['4x + x', '5x'],
    ['Xx4x2', '8X']
  ])('simplifies %s to %s', (input, expected) => {
    expect(calculate(input)?.value).toBe(expected)
  })

  it.each([
    // `x`-as-times must not make these calculator rows: application names win.
    'xterm',
    'x264',
    '4x'
  ])('still stays silent for %s', (input) => {
    expect(calculate(input)).toBeNull()
  })

  it('reads a single letter as a temperature only when everything else is one', () => {
    // `C` and `F` are the coulomb and the farad. Reading them as Celsius and
    // Fahrenheit is only safe when the whole expression is about temperature.
    expect(calculate('2 F * 3 s')?.value).toBe('6 F s')
    expect(calculate('2 kbit in b')?.value).toBe('2000 b')
  })

  it('shows the query as typed, not as rewritten', () => {
    // Seeing "5 GB in MB" under an answer you asked for as "5 gb in mb" reads as
    // the launcher having misunderstood you, even when it did not.
    expect(calculate('5 gb in mb')?.expression).toBe('5 gb in mb')
  })

  it('refuses to be a programming language', () => {
    // mathjs's `evaluate` can define variables and reach the host through
    // `import`. The input here is whatever was typed into a search bar.
    expect(calculate('x=5')).toBeNull()
    expect(calculate('import("fs")')).toBeNull()
    expect(calculate('createUnit("x", "1 m")')).toBeNull()
  })

  it('drops a result that is not a number to show', () => {
    expect(calculate('100/0')).toBeNull()
    expect(calculate('0/0')).toBeNull()
  })

  it('rounds away binary floating point noise', () => {
    // `0.30000000000000004` is correct and useless.
    expect(calculate('0.1+0.2')?.value).toBe('0.3')
  })
})

describe('web searches', () => {
  it('encodes the query as one parameter value', () => {
    // Without this, searching for `a&b=c` silently becomes two parameters.
    expect(buildSearchUrl('https://x/?q={}', 'a&b=c')).toBe('https://x/?q=a%26b%3Dc')
  })

  it('splits a keyword from its term', () => {
    const searches = [{ id: 'google', keyword: 'g', name: 'Google', url: 'https://x/?q={}' }]
    expect(matchKeyword('g wayland scaling', searches)?.term).toBe('wayland scaling')
    expect(matchKeyword('g   ', searches)).toBeNull()
    expect(matchKeyword('gg wayland', searches)).toBeNull()
  })

  it('opens only web addresses', () => {
    // A search template is user-editable config that becomes a URL handed to the
    // system opener, and `xdg-open` will happily open a local file.
    expect(isOpenableUrl('https://example.com/?q=x')).toBe(true)
    expect(isOpenableUrl('http://example.com')).toBe(true)
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableUrl('not a url')).toBe(false)
  })

  it('rejects a configured search that is not a web search', () => {
    const rejected = loadConfig({
      fileContents: '[search]\nweb_searches = [{ keyword = "f", name = "F", url = "file:///{}" }]\n',
      env: {}
    })
    expect(rejected.search.webSearches.value).toEqual([])
  })

  it('accepts a bare domain, because that is what people type', () => {
    // Requiring `https://raycast.com/?q={}` asks someone to know a scheme, a URL
    // convention and a placeholder syntax before they can add a search.
    expect(normalizeSearchTemplate('raycast.com')).toBe('https://raycast.com/?q={}')
    expect(normalizeSearchTemplate('  raycast.com  ')).toBe('https://raycast.com/?q={}')
    // A site we already ship gets its real template, not the `?q=` guess.
    expect(normalizeSearchTemplate('youtube.com')).toBe(
      'https://www.youtube.com/results?search_query={}'
    )
    // A copied search URL with the term deleted puts the placeholder back.
    expect(normalizeSearchTemplate('example.com/find?q=')).toBe('https://example.com/find?q={}')
    // Other tools' placeholders, so a template pasted from one of them works.
    expect(normalizeSearchTemplate('https://x.com/s?q={query}')).toBe('https://x.com/s?q={}')
    expect(normalizeSearchTemplate('https://x.com/s?q=%s')).toBe('https://x.com/s?q={}')
    // An already-good template is left exactly alone.
    expect(normalizeSearchTemplate('https://x.com/s?query={}')).toBe('https://x.com/s?query={}')
  })

  it('will not normalise something that is not a web address', () => {
    // The scheme gate moved in here, so it has to still be a gate.
    expect(normalizeSearchTemplate('file:///etc/passwd')).toBeNull()
    expect(normalizeSearchTemplate('javascript:alert(1)')).toBeNull()
    expect(normalizeSearchTemplate('https://')).toBeNull()
    expect(normalizeSearchTemplate('')).toBeNull()
  })

  it('normalises a hand-written config entry too', () => {
    const config = loadConfig({
      fileContents:
        '[search]\nweb_searches = [{ keyword = "r", name = "Raycast", url = "raycast.com" }]\n',
      env: {}
    })
    expect(config.search.webSearches.value.at(-1)?.url).toBe('https://raycast.com/?q={}')
  })

  it('suggests a name and keyword so adding a search is one thing to type', () => {
    expect(suggestSearchIdentity('https://crates.io/search?q={}')).toEqual({
      name: 'Crates',
      keyword: 'crates'
    })
  })

  it('keeps the valid entries when one is malformed', () => {
    const mixed = loadConfig({
      fileContents:
        '[search]\nweb_searches = [{ keyword = "bad" }, { keyword = "g", name = "G", url = "https://x/?q={}" }]\n',
      env: {}
    })
    expect(mixed.search.webSearches.value).toHaveLength(1)
  })
})
