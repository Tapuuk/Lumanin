import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fuzzyMatch, matchFields, matchGroup, TIER } from '../src/shared/fuzzy'
import { decay, HALF_LIFE_DAYS, rank } from '../src/shared/frecency'
import { FrecencyStore } from '../src/node/frecency-store'

/**
 * Ranking is what makes a launcher feel psychic or feel random, and it is
 * entirely arithmetic — so it is entirely testable. Each case here is a
 * behaviour a user would notice, written as the comparison they would make.
 */

const better = (needle: string, winner: string, loser: string): void => {
  const a = fuzzyMatch(needle, winner)
  const b = fuzzyMatch(needle, loser)
  expect(a, `"${needle}" should match "${winner}"`).not.toBeNull()
  expect(b, `"${needle}" should match "${loser}"`).not.toBeNull()
  expect(a?.score, `"${needle}": ${winner} > ${loser}`).toBeGreaterThan(b?.score ?? 0)
}

describe('fuzzy matching', () => {
  it('requires the characters in order', () => {
    expect(fuzzyMatch('fox', 'firefox')).not.toBeNull()
    expect(fuzzyMatch('xof', 'firefox')).toBeNull()
    expect(fuzzyMatch('zzz', 'firefox')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('FF', 'Firefox')).not.toBeNull()
  })

  it('refuses a scattered subsequence outright, rather than ranking it low', () => {
    // The bug this closes, reported from a real panel: typing "raycast" put
    // LibreOffice Draw at the top, because its `Keywords=` line really does
    // contain those seven letters in order. Scoring it low was not enough —
    // with nothing else matching it was still the best row on screen.
    const keywords =
      'Vector;Schema;Diagram;Layout;OpenDocument Graphics;Microsoft Publisher;' +
      'Microsoft Visio;Corel Draw;cdr;odg;svg;pdf;vsd;'
    expect(fuzzyMatch('raycast', keywords)).toBeNull()

    expect(fuzzyMatch('fox', 'Fedora Xorg Options')).toBeNull()
    expect(fuzzyMatch('vsc', 'Revised Codec')).toBeNull()
  })

  it('still accepts the shapes people actually type', () => {
    // One run, an initialism, and two runs close together — the three the gate
    // admits. Every one of these is a match somebody meant.
    expect(fuzzyMatch('fox', 'Firefox')?.positions).toEqual([4, 5, 6])
    expect(fuzzyMatch('vsc', 'Visual Studio Code')?.positions).toEqual([0, 7, 14])
    expect(fuzzyMatch('gimp', 'GNU Image Manipulation Program')?.positions).toEqual([0, 4, 10, 23])
    expect(fuzzyMatch('ff', 'Firefox')?.positions).toEqual([0, 4])
  })

  it('keeps a clean run rather than tightening it apart', () => {
    // Tightening drags the `e` onto the one in "Offic(e)", splitting a perfect
    // five-character run into two pieces eleven apart — which the gate then
    // rejects, and "libre" stops finding LibreOffice at all.
    expect(fuzzyMatch('libre', 'LibreOffice Calc')?.positions).toEqual([0, 1, 2, 3, 4])
  })

  it('prefers a prefix over a match buried in the middle', () => {
    better('term', 'Terminal', 'GNOME Terminal Server Settings')
  })

  it('breaks ties towards the shorter name', () => {
    better('file', 'Files', 'File Manager Preferences Dialog')
  })

  it('matches everything with an empty needle, so the root list ranks by habit', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [], typos: 0, tier: 0, at: 0 })
  })

  it('matches a multi-word query word by word', () => {
    // Scoring the space as a character would start the second token mid-word and
    // cost it the word-start bonus it should be collecting.
    expect(fuzzyMatch('libre calc', 'LibreOffice Calc')).not.toBeNull()
    expect(fuzzyMatch('calc libre', 'LibreOffice Calc')).toBeNull()
  })

  it('forgives a typo, without ever preferring one', () => {
    const typo = fuzzyMatch('racyast', 'Raycast')
    expect(typo?.typos).toBe(1)
    // A transposition is one edit, not two: "racyast" is the commonest way to
    // mistype it, and under plain Levenshtein it would cost the whole budget.
    expect(fuzzyMatch('obsidain', 'Obsidian')?.typos).toBe(1)
    // ...but a repaired match must never outrank a real one.
    expect(fuzzyMatch('raycast', 'Raycast')?.score).toBeGreaterThan(typo?.score ?? 0)
    // Three characters is too short to tell a typo from a different word.
    expect(fuzzyMatch('cat', 'car')).toBeNull()
  })

  it('will not fuzzy-match prose fields at all', () => {
    // `word` mode is what keeps a 120-character keyword list from answering
    // every query. A real word in it still matches.
    const keywords = 'Vector;Schema;Diagram;Corel Draw;cdr;odg;svg'
    expect(fuzzyMatch('diagram', keywords, 'word')).not.toBeNull()
    expect(fuzzyMatch('diag', keywords, 'word')).not.toBeNull()
    expect(fuzzyMatch('dgm', keywords, 'word')).toBeNull()
    // Mid-word is not a word start, so "ector" does not find "Vector".
    expect(fuzzyMatch('ector', keywords, 'word')).toBeNull()
  })

  it('tiers a match by how it was found, not just how well', () => {
    // The order asked for, in the user's words: what *starts* with what you
    // typed comes first, then matches further and further into the name.
    expect(fuzzyMatch('draw', 'Draw')?.tier).toBe(TIER.PREFIX)
    expect(fuzzyMatch('draw', 'LibreOffice Draw')?.tier).toBe(TIER.WORD_START)
    expect(fuzzyMatch('raw', 'Draw')?.tier).toBe(TIER.NAME_ELSEWHERE)
    // A repair is a guess, and lands below even a keyword match.
    expect(fuzzyMatch('paint', 'Print')?.tier).toBe(TIER.TYPO)
  })

  it('will not let a keyword answer a query the name answers', () => {
    // The defect this exists for, reported from a real panel: typing "draw"
    // offered Pinta as well as LibreOffice Draw, because Pinta's `Keywords=`
    // line begins `draw;drawing;paint;` — a perfect prefix match, of a keyword.
    // If you want to draw in Pinta you type "pinta".
    const pinta = matchFields('draw', [
      { name: 'name', text: 'Pinta', weight: 1, isName: true },
      { name: 'keywords', text: 'draw drawing paint painting', weight: 0.6, mode: 'word' }
    ])
    const libre = matchFields('draw', [
      { name: 'name', text: 'LibreOffice Draw', weight: 1, isName: true },
      { name: 'keywords', text: 'vector schema diagram', weight: 0.6, mode: 'word' }
    ])

    // Pinta still *matches* — it is the composer that drops the weaker group —
    // but it can never be in the same group as a name match.
    expect(matchGroup(pinta?.tier as never)).toBeGreaterThan(matchGroup(libre?.tier as never))

    // ...and with nothing named "paint", the keyword is exactly how Pinta is
    // found. Removing keyword matching would have broken that.
    expect(matchFields('paint', [
      { name: 'name', text: 'Pinta', weight: 1, isName: true },
      { name: 'keywords', text: 'draw drawing paint painting', weight: 0.6, mode: 'word' }
    ])).not.toBeNull()
  })

  it('reports which field won so highlighting cannot lie', () => {
    const fields = [
      { name: 'name', text: 'Firefox', weight: 1 },
      { name: 'keywords', text: 'browser web internet', weight: 0.6 }
    ]

    expect(matchFields('firefox', fields)?.field).toBe('name')
    expect(matchFields('browser', fields)?.field).toBe('keywords')
  })

  it('keeps a name match ahead of a keyword match of the same text', () => {
    // Otherwise typing an app's actual name can rank a different app whose
    // keywords happen to contain it first.
    const best = matchFields('web', [
      { name: 'name', text: 'Web', weight: 1 },
      { name: 'keywords', text: 'web', weight: 0.6 }
    ])
    expect(best?.field).toBe('name')
  })
})

describe('single-typo tolerance', () => {
  // The row this exists for: an extension command, matched at the root.
  const target = 'Search 1Password'

  it('forgives one error of every Damerau-Levenshtein kind', () => {
    // Deletion of the `a`. This one still matches *strictly* — `1pssword` is a
    // subsequence of `1Password` in two close runs — which is the stronger
    // guarantee: the typo path is a fallback and must not even be consulted
    // when the row already matches through a real tier.
    const deletion = fuzzyMatch('1pssword', target)
    expect(deletion).not.toBeNull()
    expect(deletion?.typos).toBe(0)
    expect(deletion?.tier).not.toBe(TIER.TYPO)

    // Adjacent transposition, early and late in the word.
    expect(fuzzyMatch('1psasword', target)?.typos).toBe(1)
    expect(fuzzyMatch('1passwrod', target)?.typos).toBe(1)
    // Substitution.
    expect(fuzzyMatch('1passeord', target)?.typos).toBe(1)
    // Insertion.
    expect(fuzzyMatch('1passsword', target)?.typos).toBe(1)
  })

  it('rejects two errors, however long the word', () => {
    // Deletion + transposition.
    expect(fuzzyMatch('1psswrod', target)).toBeNull()
    // Two substitutions.
    expect(fuzzyMatch('1passeorf', target)).toBeNull()
    // Substitution + transposition on an eight-character word — the length
    // that used to be granted a second edit, and no longer is.
    expect(fuzzyMatch('obsedain', 'Obsidian')).toBeNull()
  })

  it('puts a repaired match in the lowest tier, below every healthy match', () => {
    const repaired = fuzzyMatch('1passwrod', target)
    expect(repaired?.tier).toBe(TIER.TYPO)
    // TYPO is its own display group, shown only when nothing else matched.
    expect(matchGroup(TIER.TYPO)).toBe(2)

    // A row whose keywords really say the word beats a row whose name merely
    // repairs onto it: `paint` belongs to Pinta's keywords, not to Print.
    const keyword = matchFields('paint', [
      { name: 'name', text: 'Pinta', weight: 1, isName: true },
      { name: 'keywords', text: 'draw;drawing;paint', weight: 1, mode: 'word' }
    ])
    const guess = matchFields('paint', [
      { name: 'name', text: 'Print Settings', weight: 1, isName: true }
    ])
    expect(keyword?.tier).toBe(TIER.NOT_NAME)
    expect(guess?.tier).toBe(TIER.TYPO)
    expect(guess!.tier).toBeGreaterThan(keyword!.tier)
    // And every name tier beats both.
    expect(fuzzyMatch('1password', target)?.tier).toBe(TIER.WORD_START)
  })

  it('gives short queries no typo tolerance at all', () => {
    // One edit on a three-character token matches half the dictionary.
    expect(fuzzyMatch('zat', 'Cats')).toBeNull()
    // Four characters is the floor: the same edit is accepted there.
    expect(fuzzyMatch('zats', 'Cats')?.typos).toBe(1)
  })

  it('is skipped entirely for a caller asking to match exactly', () => {
    const exactly = { allowTypos: false }
    expect(fuzzyMatch('racyast', 'Raycast', 'fuzzy', exactly)).toBeNull()
    expect(fuzzyMatch('obsidain', 'Obsidian', 'fuzzy', exactly)).toBeNull()
    // Left alone, or asked for, the same needle still repairs.
    expect(fuzzyMatch('racyast', 'Raycast')?.typos).toBe(1)
    expect(fuzzyMatch('racyast', 'Raycast', 'fuzzy', { allowTypos: true })?.typos).toBe(1)

    const fields = [
      { name: 'name', text: 'Raycast', weight: 1, isName: true },
      { name: 'keywords', text: 'launcher;palette', weight: 1, mode: 'word' as const }
    ]
    expect(matchFields('racyast', fields, exactly)).toBeNull()
    expect(matchFields('racyast', fields)?.tier).toBe(TIER.TYPO)
    // Only the repair goes: everything that matched without one still matches.
    expect(matchFields('raycast', fields, exactly)?.tier).toBe(TIER.PREFIX)
    expect(matchFields('launcher', fields, exactly)?.tier).toBe(TIER.NOT_NAME)
  })

  it('is where the cost of a miss over a large index lives', () => {
    // Not a benchmark - a net for an order-of-magnitude regression. It fails if
    // asking to match exactly ever stops being the cheaper of the two.
    const corpus = Array.from({ length: 2000 }, (_, index) => [
      { name: 'name', text: `Synthetic Application ${index}`, weight: 1, isName: true },
      { name: 'keywords', text: `alpha beta gamma ${index}`, weight: 0.6, mode: 'word' as const }
    ])
    // Four characters, so long enough to be worth repairing, and matching
    // nothing in the corpus by either route.
    const needles = Array.from({ length: 20 }, (_, index) => `zqv${String.fromCharCode(97 + index)}`)

    const scan = (allowTypos: boolean): number => {
      let matched = 0
      const started = performance.now()
      for (const needle of needles) {
        for (const fields of corpus) {
          if (matchFields(needle, fields, { allowTypos }) !== null) matched += 1
        }
      }
      const elapsed = performance.now() - started
      expect(matched).toBe(0)
      return elapsed
    }

    // Both paths run once first, so the measured pair is not also measuring
    // which one the compiler happened to warm up.
    scan(false)
    scan(true)

    const exactly = scan(false)
    const repairing = scan(true)

    expect(exactly).toBeLessThan(repairing)
    // Wide on purpose: a loaded machine must not fail this, a lost second pass
    // over 2000 entries must.
    expect(exactly).toBeLessThan(2000)
  })
})

describe('a field that carries its own lowered copy', () => {
  const name = 'LibreOffice Calc'
  const plain = (): ReturnType<typeof matchFields> =>
    matchFields('calc', [{ name: 'name', text: name, weight: 1, isName: true }])

  it('answers exactly as the same field without one', () => {
    const lowered = matchFields('calc', [
      { name: 'name', text: name, lower: name.toLowerCase(), weight: 1, isName: true }
    ])
    expect(lowered).toEqual(plain())
    // The positions still index the original text, mixed case and all.
    expect(lowered?.positions.map((at) => name[at]).join('')).toBe('Calc')
  })

  it('is ignored unless it lines up with the text character for character', () => {
    // Lowering is not length-preserving in every script, and a shorter copy
    // would slide every reported position. It is dropped rather than trusted.
    const wrong = matchFields('calc', [
      { name: 'name', text: name, lower: 'libre', weight: 1, isName: true }
    ])
    expect(wrong).toEqual(plain())
  })
})

describe('frecency', () => {
  const DAY = 86_400_000

  it('halves a score over the half-life', () => {
    const now = Date.now()
    expect(decay(100, now, now + HALF_LIFE_DAYS * DAY)).toBeCloseTo(50, 5)
    expect(decay(100, now, now + 2 * HALF_LIFE_DAYS * DAY)).toBeCloseTo(25, 5)
  })

  it('never decays to zero, so nothing you use is permanently demoted', () => {
    const now = Date.now()
    expect(decay(100, now, now + 3650 * DAY)).toBeGreaterThan(0)
  })

  it('ranks by habit alone when the query is empty', () => {
    const now = Date.now()
    const often = rank(0, { score: 40, lastUsed: now }, now)
    const rarely = rank(0, { score: 1, lastUsed: now }, now)

    expect(often).toBeGreaterThan(rarely)
  })

  it('cannot promote a poor match over a good one, however often it is used', () => {
    // The failure this prevents: a launcher that opens your most-used app no
    // matter what you typed.
    const now = Date.now()
    const heavilyUsedPoorMatch = rank(20, { score: 10_000, lastUsed: now }, now)
    const neverUsedGoodMatch = rank(60, undefined, now)

    expect(neverUsedGoodMatch).toBeGreaterThan(heavilyUsedPoorMatch)
  })

  it('breaks a tie between comparable matches by habit', () => {
    const now = Date.now()
    const used = rank(50, { score: 30, lastUsed: now }, now)
    const unused = rank(50, undefined, now)

    expect(used).toBeGreaterThan(unused)
  })

  it('lets recent use outweigh stale use', () => {
    const now = Date.now()
    const recent = rank(50, { score: 5, lastUsed: now }, now)
    const stale = rank(50, { score: 20, lastUsed: now - 180 * DAY }, now)

    expect(recent).toBeGreaterThan(stale)
  })
})

describe('the frecency store', () => {
  const store = (): FrecencyStore => new FrecencyStore(mkdtempSync(join(tmpdir(), 'lumanin-frec-')))

  it('accumulates launches and survives reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumanin-frec-'))
    const first = new FrecencyStore(directory)
    first.record('a.desktop')
    first.record('a.desktop')
    first.record('b.desktop')
    first.close()

    const reopened = new FrecencyStore(directory)
    const all = reopened.all()

    expect(all.get('a.desktop')?.launches).toBe(2)
    expect(all.get('a.desktop')?.score).toBeGreaterThan(all.get('b.desktop')?.score ?? 0)
    reopened.close()
  })

  it('weights a later launch more than an earlier one', () => {
    // The whole point of an epoch-anchored weight: totals from different times
    // stay comparable without rewriting the table.
    const db = store()
    const now = Date.now()
    db.record('old.desktop', now - 60 * 86_400_000)
    db.record('new.desktop', now)

    const all = db.all()
    expect(all.get('new.desktop')?.score).toBeGreaterThan(all.get('old.desktop')?.score ?? 0)
    db.close()
  })

  it('reads the table once until a launch changes it', () => {
    const db = store()
    db.record('a.desktop')

    const first = db.all()
    expect(db.all()).toBe(first)

    db.record('b.desktop')
    const third = db.all()
    expect(third).not.toBe(first)
    expect(third.get('b.desktop')?.launches).toBe(1)
    db.close()
  })

  it('forgets on request', () => {
    const db = store()
    db.record('gone.desktop')
    // Read before the forget: a held map that is never dropped would still
    // answer with the removed row.
    expect(db.all().has('gone.desktop')).toBe(true)
    db.forget('gone.desktop')

    expect(db.all().has('gone.desktop')).toBe(false)
    db.close()
  })
})
