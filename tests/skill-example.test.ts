import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildExtension } from '../src/main/extensions/build'

/**
 * The example plugin the generator skill ships has to build.
 *
 * It lives under `.claude/`, outside every tsconfig, so nothing else in the
 * repository compiles it and a typo in it would first surface for whoever
 * installed it.
 */
const EXAMPLE = fileURLToPath(new URL('../.claude/skills/lumanin-plugin/example', import.meta.url))

describe('the generator skill example', () => {
  it('builds', async () => {
    const result = await buildExtension({
      source: EXAMPLE,
      destination: mkdtempSync(join(tmpdir(), 'lumanin-skill-example-'))
    })
    expect(result.failures).toEqual([])
    expect(result.built).toEqual(['units'])
  })
})
