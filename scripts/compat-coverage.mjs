/**
 * Compat coverage, as a number.
 *
 * Track coverage numerically: a checklist of prose can hide a 40% hole; a
 * ratio cannot. Run against a built shim:
 *
 *     npm run build && node scripts/compat-coverage.mjs
 *
 * It compares the **runtime value** exports of the pinned `@raycast/api` against
 * what the built `lumanin` module (`out/main/lumanin.js`) actually exports. Type-only exports are excluded
 * because they have no runtime form to implement — counting them would inflate
 * the ratio with symbols that are satisfied by definition.
 *
 * A name existing is not the same as the API being built. `pending()` returns a
 * function that throws the reason it is unbuilt; under a name-only count that
 * reads as implemented, and the shim once reported 88/88 with Form, Grid,
 * `launchCommand` and six hooks unwritten. So the shim stamps every stub (`Symbol.for('lumanin.pending')`,
 * `…unsupported`, `…declined`) and this script walks the export graph reading
 * those marks — top-level *and* members, which is the only way `Action.PickDate`
 * is ever counted at all.
 *
 * Four numbers, not one, because "this throws" has four different answers to
 * "so what do I do instead":
 *
 *   built       — nothing; use it
 *   pending     — wait; it is coming, and the mark says why it is not built yet
 *   unsupported — give up; Linux cannot do this (the macOS-only policy)
 *   declined    — take the other route; we will not build it, and the mark says
 *                 what to use instead (OAuth)
 *
 * The headline ratio is built-only. That is the number a release gate reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))

const dts = fs.readFileSync(path.join(root, 'spec/node_modules/@raycast/api/types/index.d.ts'), 'utf8').replace(/\r/g, '')

// Exported symbols, and which of them are @deprecated.
const exported = new Map()
const lines = dts.split('\n')
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*export declare (?:abstract )?(?:const|let|var|function|class|enum|namespace|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
  if (!m) continue
  // Look back through the immediately preceding comment block for @deprecated.
  let deprecated = false
  for (let j = i - 1; j >= 0 && j > i - 40; j--) {
    if (/\*\//.test(lines[j])) {
      for (let k = j; k >= 0 && k > j - 40; k--) {
        if (/@deprecated/.test(lines[k])) deprecated = true
        if (/\/\*\*/.test(lines[k])) break
      }
      break
    }
    if (lines[j].trim() !== '') break
  }
  if (!exported.has(m[1])) exported.set(m[1], deprecated)
  else if (deprecated) exported.set(m[1], true)
}

const shim = require(path.join(root, 'out/main/lumanin.js'))
const ours = new Set(Object.keys(shim))

const typeOnly = new Set()
for (const [name] of exported) {
  // Types and interfaces have no runtime form; they cannot be "implemented".
  const re = new RegExp('^\\s*export declare (?:interface|type)\\s+' + name + '\\b', 'm')
  const alsoValue = new RegExp('^\\s*export declare (?:const|let|var|function|class|enum|namespace)\\s+' + name + '\\b', 'm')
  if (re.test(dts) && !alsoValue.test(dts)) typeOnly.add(name)
}

const PENDING = Symbol.for('lumanin.pending')
const UNSUPPORTED = Symbol.for('lumanin.unsupported')
const DECLINED = Symbol.for('lumanin.declined')

/**
 * How a stub announces itself, or `null` for something actually built.
 *
 * Three ways to not exist, and they are three different answers to "what should
 * I do instead": wait (pending), give up (unsupported — Linux cannot), or take
 * the other route (declined — we will not, and here is what to use).
 */
const markOf = (value) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null
  if (PENDING in value) return { kind: 'pending', note: value[PENDING] }
  if (DECLINED in value) return { kind: 'declined', note: value[DECLINED] }
  if (UNSUPPORTED in value) return { kind: 'unsupported', note: value[UNSUPPORTED] }
  return null
}

/**
 * Every stub anywhere under our exports, by dotted path.
 *
 * Members matter as much as top-level names: `Action.PickDate` and
 * `WindowManagement.getActiveWindow` are stubs that no top-level count can see,
 * because `Action` and `WindowManagement` themselves are built and present.
 */
const stubs = []
// The spec keeps a deprecated alias for most things — `ActionPanelItem` is
// `ActionPanel.Item` is `Action` — so one stub is reachable by several paths and
// would be listed several times. Identity is what makes them one *for display*.
const found = new WeakMap()
// Counting is a separate question, and collapsing aliases must not answer it:
// `ShowInFinderAction` is its own top-level export of the spec and is its own
// stub, whether or not `Action.ShowInFinder` won the naming contest above it.
const markByPath = new Map()

/**
 * Which of two paths to the same stub to name it by.
 *
 * A live root beats a deprecated one first of all — `Action.ShowInFinder` reads
 * as the API, `ShowInFinderAction` reads as an alias nobody should write. Only
 * then depth, then length: that is what picks `Action.PickDate` out of
 * `ActionPanel.Item.PickDate` and `ActionPanelItem.PickDate`.
 */
const rank = (path) => {
  const root = path.split('.')[0]
  return [exported.get(root) === true ? 1 : 0, path.split('.').length, path.length]
}
const betterPath = (candidate, current) => {
  const a = rank(candidate)
  const b = rank(current)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}
const walk = (value, path, depth, seen) => {
  const mark = markOf(value)
  if (mark !== null) {
    markByPath.set(path, mark.kind)
    const first = found.get(value)
    if (first === undefined) {
      found.set(value, path)
      stubs.push({ path, ...mark })
    } else if (betterPath(path, first)) {
      // A plainer path reached it later — prefer that one to report it under.
      found.set(value, path)
      stubs.find((s) => s.path === first).path = path
    }
    // A marked member is a leaf: its own members, if any, say nothing more.
    return
  }
  if (depth === 0 || value === null) return
  if (typeof value !== 'object' && typeof value !== 'function') return
  if (seen.has(value)) return
  seen.add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'prototype' || key === 'caller' || key === 'arguments') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    // Read data properties only — invoking a getter to measure coverage would
    // run extension-facing code with no session behind it.
    if (descriptor === undefined || descriptor.get !== undefined) continue
    walk(descriptor.value, path + '.' + key, depth - 1, seen)
  }
}
for (const name of ours) {
  if (name.startsWith('__')) continue
  walk(shim[name], name, 3, new WeakSet())
}

const stubbedTop = new Map()
for (const [path, kind] of markByPath) {
  if (!path.includes('.')) stubbedTop.set(path, kind)
}

const values = [...exported.keys()].filter((n) => !typeOnly.has(n))
const missing = values.filter((n) => !ours.has(n))
const present = values.filter((n) => ours.has(n))
const built = present.filter((n) => !stubbedTop.has(n))
const pending = present.filter((n) => stubbedTop.get(n) === 'pending')
const unsupported = present.filter((n) => stubbedTop.get(n) === 'unsupported')
const declinedTop = present.filter((n) => stubbedTop.get(n) === 'declined')
const deprecatedValues = values.filter((n) => exported.get(n))
const deprecatedDone = deprecatedValues.filter((n) => ours.has(n) && !stubbedTop.has(n))

const pct = (n) => '(' + Math.round((n / values.length) * 100) + '%)'

console.log('spec exported symbols        :', exported.size)
console.log('  of which type-only         :', typeOnly.size)
console.log('  runtime values             :', values.length)
console.log('built / runtime values       :', built.length + ' / ' + values.length, pct(built.length))
console.log('  pending (ours to write)    :', pending.length, pct(pending.length))
console.log('  unsupported on Linux       :', unsupported.length, pct(unsupported.length))
console.log('  declined by design         :', declinedTop.length, pct(declinedTop.length))
console.log('  absent entirely            :', missing.length, pct(missing.length))
console.log('deprecated values            :', deprecatedValues.length)
console.log('  built                      :', deprecatedDone.length + ' / ' + deprecatedValues.length)
console.log('extra exports (ours only)    :', [...ours].filter((n) => !exported.has(n) && !n.startsWith('__')).join(', ') || '(none)')

const listing = (kind) =>
  stubs.filter((s) => s.kind === kind).sort((a, b) => a.path.localeCompare(b.path))
const show = (label, rows) => {
  console.log('\n' + label + ':' + (rows.length === 0 ? ' (none)' : ''))
  for (const row of rows) console.log('  ' + row.path.padEnd(44) + row.note)
}

show('PENDING — named, throws, ours to build', listing('pending'))
show('UNSUPPORTED — cannot work on Linux', listing('unsupported'))
show('DECLINED — will not be built, and what to use instead', listing('declined'))
console.log('\nABSENT:', missing.join(', ') || '(none)')
