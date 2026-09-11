import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/shared/config'

const NO_ENV = {} as const

describe('loadConfig defaults', () => {
  it('returns the documented defaults with no file and no env', () => {
    const config = loadConfig({ env: NO_ENV })

    expect(config.general.width.value).toBe(760)
    expect(config.general.height.value).toBe(480)
    expect(config.general.hideOnBlur.value).toBe(true)
    expect(config.general.escAtRoot.value).toBe('hide')
    expect(config.general.openOnMonitor.value).toBe('cursor')
    expect(config.appearance.theme.value).toBeNull()
    expect(config.general.width.layer).toBe('default')
  })
})

describe('precedence: flag > env > file > default', () => {
  const file = `
[general]
width = 900
height = 600
`

  it('takes the file value over the default', () => {
    const config = loadConfig({ fileContents: file, env: NO_ENV })
    expect(config.general.width.value).toBe(900)
    expect(config.general.width.layer).toBe('file')
    expect(config.general.width.origin).toBe('config.toml [general].width')
  })

  it('takes the env value over the file', () => {
    const config = loadConfig({ fileContents: file, env: { LUMANIN_WIDTH: '1000' } })
    expect(config.general.width.value).toBe(1000)
    expect(config.general.width.layer).toBe('env')
    expect(config.general.width.origin).toBe('LUMANIN_WIDTH')
  })

  it('takes the flag value over the env', () => {
    const config = loadConfig({
      fileContents: file,
      env: { LUMANIN_WIDTH: '1000' },
      flags: { width: '1100' }
    })
    expect(config.general.width.value).toBe(1100)
    expect(config.general.width.layer).toBe('flag')
  })

  it('resolves each key independently', () => {
    const config = loadConfig({ fileContents: file, env: { LUMANIN_WIDTH: '1000' } })
    expect(config.general.width.layer).toBe('env')
    expect(config.general.height.layer).toBe('file')
  })
})

describe('invalid values fall through instead of winning', () => {
  it('reports a hotkey it cannot write instead of binding a typo', () => {
    const config = loadConfig({
      fileContents: '[general]\nhotkey = "Super+Retrun"\n',
      env: NO_ENV
    })

    expect(config.general.hotkey.value).toBe('Super+R')
    expect(config.general.hotkey.layer).toBe('default')
    expect(config.problems.join('\n')).toContain('[general].hotkey')
  })

  it('keeps an empty file-search hotkey as "do not bind one"', () => {
    const config = loadConfig({
      fileContents: '[file_search]\nhotkey = ""\n',
      env: NO_ENV
    })

    expect(config.fileSearch.hotkey.value).toBe('')
    expect(config.problems).toHaveLength(0)
  })

  it('skips an out-of-range dimension and reports it', () => {
    const config = loadConfig({
      fileContents: '[general]\nwidth = 40000\n',
      env: NO_ENV
    })

    expect(config.general.width.value).toBe(760)
    expect(config.general.width.layer).toBe('default')
    expect(config.problems.join('\n')).toContain('[general].width')
  })

  it('skips an invalid env value and uses the file value beneath it', () => {
    const config = loadConfig({
      fileContents: '[general]\nwidth = 900\n',
      env: { LUMANIN_WIDTH: 'wide' }
    })

    expect(config.general.width.value).toBe(900)
    expect(config.general.width.layer).toBe('file')
    expect(config.problems.join('\n')).toContain('LUMANIN_WIDTH')
  })

  it('rejects an unknown enum value', () => {
    const config = loadConfig({ fileContents: '[general]\nesc_at_root = "explode"\n', env: NO_ENV })
    expect(config.general.escAtRoot.value).toBe('hide')
    expect(config.problems).toHaveLength(1)
  })

  it('accepts booleans as TOML booleans and as env strings', () => {
    expect(loadConfig({ fileContents: '[general]\nhide_on_blur = false\n', env: NO_ENV }).general.hideOnBlur.value).toBe(false)
    expect(loadConfig({ env: { LUMANIN_HIDE_ON_BLUR: 'false' } }).general.hideOnBlur.value).toBe(false)
    expect(loadConfig({ env: { LUMANIN_HIDE_ON_BLUR: '0' } }).general.hideOnBlur.value).toBe(false)
  })
})

describe('robustness', () => {
  it('starts with defaults when the file is not valid TOML', () => {
    // The launcher is what a user reaches for when something else is broken; a
    // broken config must never be the thing that stops it starting.
    const config = loadConfig({ fileContents: 'this is [not toml', env: NO_ENV })

    expect(config.general.width.value).toBe(760)
    expect(config.problems.join('\n')).toContain('could not be parsed')
  })

  it('reports a file it could not read instead of booting on defaults in silence', () => {
    const config = loadConfig({ env: NO_ENV, readProblem: 'config.toml could not be read: EACCES' })
    expect(config.general.width.value).toBe(760)
    expect(config.problems).toContain('config.toml could not be read: EACCES')
  })

  it('preserves unknown sections rather than dropping them', () => {
    const config = loadConfig({
      fileContents: '[general]\nwidth = 800\n\n[future_feature]\nenabled = true\n',
      env: NO_ENV
    })

    expect(config.unrecognized).toEqual(['future_feature'])
    expect(config.raw['future_feature']).toEqual({ enabled: true })
  })

  it('[search].typos defaults to one, takes a whole number from 0 to 5, and refuses the rest', () => {
    expect(loadConfig({ env: NO_ENV }).search.typos.value).toBe(1)
    expect(loadConfig({ fileContents: '[search]\ntypos = 3\n', env: NO_ENV }).search.typos.value).toBe(3)
    expect(loadConfig({ fileContents: '[search]\ntypos = 0\n', env: NO_ENV }).search.typos.value).toBe(0)
    expect(loadConfig({ env: { LUMANIN_TYPOS: '2' } }).search.typos.value).toBe(2)
    const refused = loadConfig({ fileContents: '[search]\ntypos = 9\n', env: NO_ENV })
    expect(refused.search.typos.value).toBe(1)
    expect(refused.problems.length).toBeGreaterThan(0)
    expect(loadConfig({ fileContents: '[search]\ntypos = 1.5\n', env: NO_ENV }).search.typos.value).toBe(1)
  })

  it('does not report documented-but-unimplemented sections as unrecognized', () => {
    const config = loadConfig({
      fileContents: '[clipboard]\nretention_days = 7\n\n[search]\nfrecency_weight = 0.4\n',
      env: NO_ENV
    })

    expect(config.unrecognized).toEqual([])
  })
})

/**
 * `[file_search]` — the section for the launcher's second search surface.
 *
 * Two settings and no more: the key that opens it (the *only* way in, since the
 * command is not at the root) and the order its results come back in.
 */
describe('[file_search]', () => {
  it('defaults to Super+Shift+R and the shipped category order', () => {
    const config = loadConfig({ env: NO_ENV })

    expect(config.fileSearch.hotkey.value).toBe('Super+Shift+R')
    expect(config.fileSearch.order.value).toEqual([
      'folders',
      'images',
      'videos',
      'archives',
      'models',
      'text',
      'executables',
      'rest'
    ])
  })

  it('takes the key from its own section', () => {
    const config = loadConfig({ fileContents: '[file_search]\nhotkey = "Super+F"\n', env: NO_ENV })

    expect(config.fileSearch.hotkey.value).toBe('Super+F')
    expect(config.fileSearch.hotkey.layer).toBe('file')
  })

  /**
   * The key spent a day in `[general]`. A config written in that window is a
   * config a person edited by hand, and silently reverting it to the default
   * would be worse than refusing to load it.
   */
  it('still reads the key from where it used to live', () => {
    const config = loadConfig({
      fileContents: '[general]\nfile_search_hotkey = "Super+F"\n',
      env: NO_ENV
    })

    expect(config.fileSearch.hotkey.value).toBe('Super+F')
    expect(config.fileSearch.hotkey.origin).toContain('[general].file_search_hotkey')
  })

  it('prefers the current spelling when a file has both', () => {
    const config = loadConfig({
      fileContents: '[general]\nfile_search_hotkey = "Super+G"\n\n[file_search]\nhotkey = "Super+F"\n',
      env: NO_ENV
    })

    expect(config.fileSearch.hotkey.value).toBe('Super+F')
  })

  it('takes an empty key as "do not bind one"', () => {
    const config = loadConfig({ fileContents: '[file_search]\nhotkey = ""\n', env: NO_ENV })

    expect(config.fileSearch.hotkey.value).toBe('')
    expect(config.fileSearch.hotkey.layer).toBe('file')
  })

  /**
   * Unlike `[search].order`, this one is always completed. Every file is in
   * exactly one category, so a category left out of the list still has to sort
   * somewhere — appending it is the only answer that does not hide files.
   */
  it('completes a partial order rather than dropping what it omits', () => {
    const config = loadConfig({
      fileContents: '[file_search]\norder = ["text", "folders"]\n',
      env: NO_ENV
    })

    expect(config.fileSearch.order.value.slice(0, 2)).toEqual(['text', 'folders'])
    expect([...config.fileSearch.order.value].sort()).toEqual(
      ['archives', 'executables', 'folders', 'images', 'models', 'rest', 'text', 'videos'].sort()
    )
  })

  it('ignores names it does not know, and falls back when none are known', () => {
    const partly = loadConfig({
      fileContents: '[file_search]\norder = ["text", "spreadsheets"]\n',
      env: NO_ENV
    })
    expect(partly.fileSearch.order.value[0]).toBe('text')
    expect(partly.fileSearch.order.value).not.toContain('spreadsheets')

    const nonsense = loadConfig({
      fileContents: '[file_search]\norder = ["spreadsheets"]\n',
      env: NO_ENV
    })
    expect(nonsense.fileSearch.order.layer).toBe('default')
  })

  it('is a section we know about', () => {
    const config = loadConfig({ fileContents: '[file_search]\nhotkey = "Super+F"\n', env: NO_ENV })
    expect(config.unrecognized).toEqual([])
  })
})

describe('[file_search].hide_on_open', () => {
  it('closes the panel after opening, by default', () => {
    // Opening a file is the *end* of a file search: the program that opens it
    // takes the keyboard, and a launcher left behind it looks alive and is not.
    expect(loadConfig({ env: NO_ENV }).fileSearch.hideOnOpen.value).toBe(true)
  })

  it('can be turned off, for opening several things in a row', () => {
    const config = loadConfig({
      fileContents: '[file_search]\nhide_on_open = false\n',
      env: NO_ENV
    })
    expect(config.fileSearch.hideOnOpen.value).toBe(false)
    expect(config.fileSearch.hideOnOpen.layer).toBe('file')
  })
})

describe('[appearance].text_scale', () => {
  it('is unset by default, meaning "follow the desktop"', () => {
    expect(loadConfig({ env: NO_ENV }).appearance.textScale.value).toBeNull()
  })

  it('takes a fractional factor from the file and from the env', () => {
    expect(
      loadConfig({ fileContents: '[appearance]\ntext_scale = 1.25\n', env: NO_ENV }).appearance.textScale.value
    ).toBe(1.25)
    expect(loadConfig({ env: { LUMANIN_TEXT_SCALE: '0.9' } }).appearance.textScale.value).toBe(0.9)
  })

  it('refuses a factor that would make the panel unusable', () => {
    const config = loadConfig({ fileContents: '[appearance]\ntext_scale = 0\n', env: NO_ENV })
    expect(config.appearance.textScale.value).toBeNull()
    expect(config.problems.join('\n')).toContain('[appearance].text_scale')
  })
})
