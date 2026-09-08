import type { Logger } from '../node/logger'
import { detectPlatform, type PlatformProfile } from '../platform/detect'
import { probeAppearanceSources, type AppearanceSources } from '../platform/probe/appearance'
import { probeBinaries, PROBED_BINARIES, type BinaryMap } from '../platform/probe/binaries'
import { UNKNOWN_DBUS_PROBE } from '../platform/probe/dbus'
import { UNPROBED_PROTOCOLS } from '../platform/probe/wayland'

/**
 * What the daemon had to do without at startup.
 *
 * A launcher nobody can summon is not a launcher, and one that opens and does
 * nothing is worse, so a failed step falls back to a reduced answer instead of
 * leaving the whole chain dead. Every fallback is logged at `error` with its
 * stack and named here in a sentence `lumanin status` shows; nothing is swallowed.
 */
export class Degradations {
  private readonly sentences: string[] = []

  constructor(private readonly logger: Pick<Logger, 'error'>) {}

  /** `failed` is what could not be done, `consequence` what the session lacks. */
  record(failed: string, consequence: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.logger.error(`startup: ${failed}`, { error, consequence })
    this.sentences.push(`${failed} (${message}); ${consequence}`)
  }

  list(): readonly string[] {
    return [...this.sentences]
  }
}

/** Run a startup step, or record why it could not run and use the fallback. */
export function runStep<T>(
  failed: string,
  consequence: string,
  run: () => T,
  fallback: () => T,
  degradations: Degradations
): T {
  try {
    return run()
  } catch (error) {
    degradations.record(failed, consequence, error)
    return fallback()
  }
}

export async function runStepAsync<T>(
  failed: string,
  consequence: string,
  run: () => Promise<T>,
  fallback: () => T,
  degradations: Degradations
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    degradations.record(failed, consequence, error)
    return fallback()
  }
}

/**
 * A profile built when `probePlatform` itself threw: the desktop name from the
 * environment, then each probe attempted on its own, each falling back to the
 * "could not check" answer its module already defines. `UNKNOWN` rather than
 * `false`, because backends select differently on each, and a machine that
 * was not checked must not be reported as one that lacks the feature.
 */
export function degradedProfile(
  env: Readonly<Record<string, string | undefined>>,
  degradations: Degradations = new Degradations({ error: () => undefined })
): PlatformProfile {
  const base = detectPlatform(env)
  const noBinaries = (): BinaryMap =>
    Object.fromEntries(PROBED_BINARIES.map((name) => [name, null])) as BinaryMap
  const binaries = runStep(
    'the $PATH probe failed',
    'helper programs are treated as missing',
    () => probeBinaries(env),
    noBinaries,
    degradations
  )
  const noAppearance = (): AppearanceSources => probeAppearanceSources({})
  const appearance = runStep(
    'the appearance probe failed',
    'the desktop theme is not followed',
    () => probeAppearanceSources(env),
    noAppearance,
    degradations
  )
  return {
    ...base,
    binaries,
    dbus: UNKNOWN_DBUS_PROBE,
    protocols: UNPROBED_PROTOCOLS,
    appearance
  }
}
