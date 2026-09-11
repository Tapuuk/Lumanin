import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * One version, spelled five ways. Nothing else asserts that they agree, and a
 * release has shipped with the changelog still saying "unreleased" under a
 * tag that existed. A red case here names the file and both values.
 */
const root = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

function capture(text: string, pattern: RegExp, file: string): string {
  const match = pattern.exec(text)
  if (match === null || match[1] === undefined) throw new Error(`${file}: no version found by ${String(pattern)}`)
  return match[1]
}

describe('the version', () => {
  it('is the same in all five files', () => {
    const spellings: Record<string, string> = {
      'package.json': (JSON.parse(read('package.json')) as { version: string }).version,
      'npm-package/package.json': (JSON.parse(read('npm-package/package.json')) as { version: string }).version,
      'packaging/aur/PKGBUILD': capture(read('packaging/aur/PKGBUILD'), /^pkgver=(\S+)$/m, 'PKGBUILD'),
      'packaging/aur/.SRCINFO': capture(read('packaging/aur/.SRCINFO'), /^\tpkgver = (\S+)$/m, '.SRCINFO'),
      'CHANGELOG.md': capture(read('CHANGELOG.md'), /^## (\d+\.\d+\.\d+)/m, 'CHANGELOG.md')
    }
    const reference = spellings['package.json']
    for (const [file, version] of Object.entries(spellings)) {
      expect(version, `${file} says ${version}, package.json says ${reference ?? ''}`).toBe(reference)
    }
  })
})

describe('the AUR checksums', () => {
  const pkgbuild = read('packaging/aur/PKGBUILD')
  const srcinfo = read('packaging/aur/.SRCINFO')
  const keys = ['sha256sums', 'sha256sums_x86_64', 'sha256sums_aarch64']

  it('agree between PKGBUILD and .SRCINFO, and none is SKIP', () => {
    for (const key of keys) {
      const inPkgbuild = capture(pkgbuild, new RegExp(`^${key}=\\('([^']+)'\\)$`, 'm'), 'PKGBUILD')
      const inSrcinfo = capture(srcinfo, new RegExp(`^\\t${key} = (\\S+)$`, 'm'), '.SRCINFO')
      expect(inSrcinfo, `${key}: PKGBUILD says ${inPkgbuild}, .SRCINFO says ${inSrcinfo}`).toBe(inPkgbuild)
      expect(inPkgbuild, `${key} is SKIP in PKGBUILD - makepkg would not verify the download`).not.toBe('SKIP')
    }
  })
})
