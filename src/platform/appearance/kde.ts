import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseKdeGlobals } from '../../shared/theme/kdeglobals'
import type { AppearanceBackend, AppearanceSignal } from './index'

/**
 * KDE Plasma — the palette straight out of `kdeglobals`.
 *
 * Plasma copies the active colour scheme's sections into `kdeglobals` when it is
 * applied, so this one file is the live palette. That is better than finding and
 * parsing the `.colors` scheme it came from: it also covers a user who tweaked
 * individual colours in System Settings without saving a scheme, which is
 * exactly the person a scheme-file reader would silently get wrong.
 *
 * Live updates come from the filesystem. Plasma rewrites `kdeglobals` on every
 * change and then broadcasts on D-Bus; watching needs no bus connection and no
 * subscription that can lapse, and it catches a hand-edit too. The watch is on
 * the **directory**, not the file: KConfig saves through QSaveFile — a temp
 * file renamed over the target — so the inode changes on every save, and a
 * watch on the file path dies after the first one.
 *
 * **UNVERIFIED** — written against the Breeze scheme format (checked against
 * `KDE/breeze`) and unit-tested against real scheme text, but never
 * run in a Plasma session. `doctor` says so until a human confirms it in a VM.
 */
export class KdeAppearance implements AppearanceBackend {
  readonly id = 'kde-colors'

  constructor(private readonly path: string) {}

  read(): Promise<AppearanceSignal | null> {
    let contents: string
    try {
      contents = readFileSync(this.path, 'utf8')
    } catch {
      return Promise.resolve(null)
    }

    const scheme = parseKdeGlobals(contents)
    if (scheme === null) return Promise.resolve(null)

    return Promise.resolve({
      seed: {
        meta: {
          name: scheme.name ?? 'KDE colour scheme',
          id: `kde:${scheme.name ?? 'kdeglobals'}`,
          author: 'KDE colour scheme'
        },
        colours: scheme.colours
      },
      source: `KDE colour scheme "${scheme.name ?? 'kdeglobals'}"`
    })
  }

  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null
    const filename = basename(this.path)

    try {
      // The parent directory, filtered to our filename: KConfig replaces the
      // file by rename, so this is the only watch that survives a save. The
      // debounce is because a single settings change touches the file more than
      // once (temp-file create + rename, at minimum).
      watcher = watch(dirname(this.path), { persistent: false }, (_event, changed) => {
        if (changed !== null && changed !== filename) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(onChange, 150)
      })
      watcher.on('error', () => undefined)
    } catch {
      return () => undefined
    }

    return () => {
      if (timer !== null) clearTimeout(timer)
      watcher?.close()
    }
  }
}
