/**
 * Refuse tracked text that points at the maintainers' private notes.
 *
 * Those notes live outside the repository, so a comment, config string or
 * test title that cites one is a dangling pointer to a reader of the public
 * tree. This scans every tracked text file line by line and prints each hit
 * as `path:line: text`, exiting 1 when there is at least one.
 *
 * Third-party trees, lockfiles and binary assets are skipped.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PATTERN = new RegExp(
  [
    '\\b(?!(?:README|CONTRIBUTING|CREDITS|SKILL)\\.md)[A-Z][A-Z_-]{2,}\\.md\\b',
    '\\b[A-Z]{4,}-[A-Z]{4,}\\b',
    '\\u00a7',
    '\\bM[0-9](\\.[0-9a-z]+)?\\b',
    'docs\\/[A-Z]',
    '\\.claude\\/agents',
    '2026-0[0-9]-[0-9]{2}',
    'Wave [0-9]',
    '[Pp]urged',
    'old[- ]ecosystem',
    '\\b[Mm]ilestone'
  ].join('|')
)

const SKIP_PATH = /^(spec\/|package-lock\.json$|npm-package\/package-lock\.json$)/
const SKIP_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf)$/

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '' && !SKIP_PATH.test(path) && !SKIP_EXT.test(path))

let hits = 0
for (const path of files) {
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (PATTERN.test(line)) {
      hits += 1
      process.stdout.write(`${path}:${index + 1}: ${line}\n`)
    }
  })
}

process.exit(hits === 0 ? 0 : 1)
