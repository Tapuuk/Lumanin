import { describe, expect, it } from 'vitest'
import { isExtensionCommandEnabled, loadConfig, parseExtensionPin } from '../src/shared/config'
import { composeRoot, shellRow, type RootCommand, type ScoredRow } from '../src/main/root-search'
import { extensionRootCommands, type ExtensionIndex } from '../src/main/extensions/registry'
import { runShellCommand } from '../src/platform/apps/launch'
import { wizard } from '../src/cli/tui'
import type { ResultItem } from '../src/shared/ipc'

/**
 * The store, the disabled list, and the `shell:` target.
 *
 * All three arrived together and share one question: what may the config name,
 * and what happens to a row it names. The parts that need a terminal or a
 * network are not here — `scripts/verify-plugins.mjs` covers those against the
 * real window, which is the only place they mean anything.
 */

const COMMANDS: readonly RootCommand[] = [
  {
    id: 'builtin/quit',
    title: 'Quit Lumanin',
    subtitle: 'Stop the daemon',
    keywords: ['exit']
  }
]

function compose(query: string, file: string, apps: readonly ScoredRow[] = []): readonly ResultItem[] {
  return composeRoot({
    query,
    config: loadConfig({ fileContents: file, env: {} }),
    commands: COMMANDS,
    apps,
    resolveAlias: (target) => {
      const command = COMMANDS.find((candidate) => candidate.id === target)
      return command === undefined
        ? null
        : { id: `command:${command.id}`, title: command.title, kind: 'command' }
    }
  })
}

describe('shell: targets', () => {
  it('accepts a shell pin, which older versions dropped as an unknown kind', () => {
    const config = loadConfig({
      fileContents: '[search]\npins = ["shell:systemctl suspend"]\n',
      env: {}
    })
    expect(config.search.pins.value).toEqual([{ key: 'shell:systemctl suspend', title: null, icon: null }])
    expect(config.problems).toEqual([])
  })

  it('accepts an extension pin, which is the key the picker actually writes', () => {
    const config = loadConfig({
      fileContents: '[search]\npins = ["extension:hacker-news/frontpage"]\n',
      env: {}
    })
    expect(config.search.pins.value).toEqual([{ key: 'extension:hacker-news/frontpage', title: null, icon: null }])
  })

  it('keeps a pinned command line off the empty root', () => {
    // The empty root is a bare search bar (user decision).
    expect(compose('', '[search]\npins = ["shell:systemctl suspend"]\n')).toEqual([])
  })

  it('keeps a pinned command line visible under a query that matches it', () => {
    const rows = compose('suspend', '[search]\npins = ["shell:systemctl suspend"]\n')
    expect(rows[0]?.id).toBe('shell:systemctl suspend')
  })

  it('hides it under a query that does not', () => {
    // The whole point of matching a shell pin rather than injecting it: a pin
    // that appeared under every query would be a permanent row of noise.
    const rows = compose('firefox', '[search]\npins = ["shell:systemctl suspend"]\n')
    expect(rows.some((row) => row.kind === 'shell')).toBe(false)
  })

  it('injects one named by a rule whether or not it matches', () => {
    const rows = compose(
      'sleep',
      '[[search.rules]]\nmatch = "sleep"\nfirst = ["shell:systemctl suspend"]\n'
    )
    expect(rows[0]?.id).toBe('shell:systemctl suspend')
  })

  it('runs the line through a shell as one argv element, never concatenated', () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const ok = runShellCommand('echo hi && echo there', { SHELL: '/bin/zsh' }, (command, args) => {
      calls.push({ command, args })
      return true
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([{ command: '/bin/zsh', args: ['-c', 'echo hi && echo there'] }])
  })

  it('falls back to /bin/sh where $SHELL is unset', () => {
    const calls: string[] = []
    runShellCommand('true', {}, (command) => {
      calls.push(command)
      return true
    })
    expect(calls).toEqual(['/bin/sh'])
  })

  it('titles the row with the command itself', () => {
    // Never a friendly name over a shell command: showing the line that is about
    // to run is the only label that cannot mislead.
    expect(shellRow('rm -rf /tmp/x').title).toBe('rm -rf /tmp/x')
  })
})

describe('[extensions].disabled', () => {
  const index = (): ExtensionIndex => ({
    extensions: [],
    problems: [],
    commands: [
      { id: 'hacker-news/frontpage', spec: spec('frontpage', 'Front Page'), entryPath: '', extension: extension('hacker-news') },
      { id: 'hacker-news/newest', spec: spec('newest', 'Newest'), entryPath: '', extension: extension('hacker-news') },
      { id: 'devdocs/search', spec: spec('search', 'Search'), entryPath: '', extension: extension('devdocs') }
    ] as ExtensionIndex['commands']
  })

  it('reads the list', () => {
    const config = loadConfig({
      fileContents: '[extensions]\ndisabled = ["devdocs", "hacker-news/newest"]\n',
      env: {}
    })
    expect(config.extensions.disabled.value).toEqual(['devdocs', 'hacker-news/newest'])
    expect(config.extensions.disabled.layer).toBe('file')
  })

  it('is empty by default, so nothing is hidden until someone says so', () => {
    expect(loadConfig({ fileContents: '', env: {} }).extensions.disabled.value).toEqual([])
  })

  it('hides one command without hiding its extension', () => {
    expect(isExtensionCommandEnabled(['hacker-news/newest'], 'hacker-news/newest')).toBe(false)
    expect(isExtensionCommandEnabled(['hacker-news/newest'], 'hacker-news/frontpage')).toBe(true)
  })

  it('hides every command of a disabled extension without naming them', () => {
    expect(isExtensionCommandEnabled(['hacker-news'], 'hacker-news/frontpage')).toBe(false)
    expect(isExtensionCommandEnabled(['hacker-news'], 'hacker-newsy/frontpage')).toBe(true)
  })

  it('keeps disabled commands out of the root list and nowhere else', () => {
    const disabled = ['devdocs', 'hacker-news/newest']
    const rows = extensionRootCommands(index(), (id) => isExtensionCommandEnabled(disabled, id))
    expect(rows.map((row) => row.id)).toEqual(['hacker-news/frontpage'])

    // The index itself still has all three: the store screen has to list a
    // disabled command in order to offer turning it back on.
    expect(index().commands).toHaveLength(3)
  })
})

describe('root row icons', () => {
  const index = (icon: string | undefined, manifestIcon?: string): ExtensionIndex => ({
    extensions: [],
    problems: [],
    commands: [
      {
        id: 'godot-docs/search',
        spec: { ...spec('search', 'Search Godot'), ...(icon === undefined ? {} : { icon }) },
        entryPath: '',
        extension: {
          ...extension('godot-docs'),
          manifest: {
            ...extension('godot-docs').manifest,
            ...(manifestIcon === undefined ? {} : { icon: manifestIcon })
          }
        }
      }
    ] as unknown as ExtensionIndex['commands']
  })

  it('turns search: into a theme URL wearing the search mark', () => {
    const [row] = extensionRootCommands(index('search:godot,godot-engine'))
    expect(row?.icon).toBe('lumanin-icon://theme/godot%2Cgodot-engine')
    expect(row?.badge).toBe('search')
  })

  it('turns system: into the same URL without the mark', () => {
    const [row] = extensionRootCommands(index('system:folder'))
    expect(row?.icon).toBe('lumanin-icon://theme/folder')
    expect(row?.badge).toBeUndefined()
  })

  it('treats anything else as a file in the extension assets', () => {
    const [row] = extensionRootCommands(index('icon.svg'))
    expect(row?.icon).toBe('lumanin-icon://ext/godot-docs/icon.svg')
    expect(row?.badge).toBeUndefined()
  })

  it('falls back to the manifest icon when the command declares none', () => {
    const [row] = extensionRootCommands(index(undefined, 'icon.svg'))
    expect(row?.icon).toBe('lumanin-icon://ext/godot-docs/icon.svg')
  })

  it('leaves both off when neither declares one', () => {
    const [row] = extensionRootCommands(index(undefined))
    expect(row?.icon).toBeUndefined()
    expect(row?.badge).toBeUndefined()
  })
})

describe('wizard', () => {
  it('runs the steps in order and reports completion', async () => {
    const seen: number[] = []
    const done = await wizard([
      () => {
        seen.push(0)
        return Promise.resolve('next' as const)
      },
      () => {
        seen.push(1)
        return Promise.resolve('next' as const)
      }
    ])
    expect(done).toBe(true)
    expect(seen).toEqual([0, 1])
  })

  it('re-enters the previous step on back, rather than unwinding', async () => {
    const seen: number[] = []
    let firstVisit = true
    const done = await wizard([
      () => {
        seen.push(0)
        return Promise.resolve('next' as const)
      },
      () => {
        seen.push(1)
        if (firstVisit) {
          firstVisit = false
          return Promise.resolve('back' as const)
        }
        return Promise.resolve('next' as const)
      }
    ])
    expect(done).toBe(true)
    expect(seen).toEqual([0, 1, 0, 1])
  })

  it('leaves only when the first step goes back', async () => {
    const done = await wizard([() => Promise.resolve('back' as const), () => Promise.resolve('next' as const)])
    expect(done).toBe(false)
  })
})

function spec(name: string, title: string): ExtensionIndex['commands'][number]['spec'] {
  return {
    name,
    title,
    mode: 'view',
    keywords: [],
    arguments: [],
    preferences: [],
    categories: [],
    root: true,
    disabledByDefault: false
  } as ExtensionIndex['commands'][number]['spec']
}

function extension(name: string): ExtensionIndex['commands'][number]['extension'] {
  return {
    directory: '',
    assetsPath: '',
    supportPath: '',
    manifest: {
      name,
      title: name,
      description: '',
      author: '',
      commands: [],
      preferences: [],
      keywords: [],
      external: [],
      tools: []
    }
  } as unknown as ExtensionIndex['commands'][number]['extension']
}

describe('category and item pins', () => {
  const EXT_COMMANDS: readonly RootCommand[] = [
    ...COMMANDS,
    {
      id: '1password/search',
      title: 'Search 1Password',
      subtitle: '1Password',
      keywords: [],
      kind: 'extension',
      extensionTitle: '1Password',
      categories: [
        { id: 'logins', title: 'Logins' },
        { id: 'cards', title: 'Credit Cards' }
      ]
    }
  ]

  const composeExt = (query: string, file: string): readonly ResultItem[] =>
    composeRoot({
      query,
      config: loadConfig({ fileContents: file, env: {} }),
      commands: EXT_COMMANDS,
      apps: [],
      resolveAlias: () => null
    })

  it('keeps a pinned category off the empty root', () => {
    // The empty root is a bare search bar (user decision).
    expect(composeExt('', '[search]\npins = ["extension:1password/search#logins"]\n')).toEqual([])
  })

  it('keeps it visible under a query matching its title, typo included', () => {
    const file = '[search]\npins = ["extension:1password/search#logins"]\n'
    expect(composeExt('logins', file)[0]?.id).toBe('extension:1password/search#logins')
    expect(composeExt('lgins', file)[0]?.id).toBe('extension:1password/search#logins')
    expect(composeExt('firefox', file).some((row) => row.id.includes('#'))).toBe(false)
  })

  it('never surfaces an unpinned category, which is the whole deal', () => {
    expect(composeExt('logins', '').some((row) => row.id.includes('#'))).toBe(false)
    expect(composeExt('', '').length).toBe(0)
  })

  it('draws an item pin with its stored title, once its title is typed', () => {
    const rows = composeExt(
      'git',
      '[search]\npins = [{ id = "extension:1password/search#logins:a1b2", title = "GitHub" }]\n'
    )
    expect(rows.filter((row) => row.kind === 'extension')).toEqual([
      {
        id: 'extension:1password/search#logins:a1b2',
        title: 'GitHub',
        subtitle: '1Password · Logins',
        kind: 'extension'
      }
    ])
  })

  it('lets a stale pin vanish rather than become a dead row', () => {
    // The plugin no longer declares that category (or was uninstalled).
    const rows = composeExt('', '[search]\npins = ["extension:1password/search#vaults"]\n')
    expect(rows).toEqual([])
  })

  it('draws an action pin — one action on one row — with its stored title', () => {
    const rows = composeExt(
      'git',
      '[search]\npins = [{ id = "extension:1password/search#logins:a1b2!Copy Password", title = "GitHub — Copy Password" }]\n'
    )
    expect(rows.filter((row) => row.kind === 'extension')).toEqual([
      {
        id: 'extension:1password/search#logins:a1b2!Copy Password',
        title: 'GitHub — Copy Password',
        subtitle: '1Password · Logins',
        kind: 'extension'
      }
    ])
  })

  it('names a row of a command that declares no categories, with an empty one', () => {
    const rows = composeRoot({
      query: 'ngi',
      config: loadConfig({
        fileContents: '[search]\npins = [{ id = "extension:units/list#:nginx", title = "nginx" }]\n',
        env: {}
      }),
      commands: [
        {
          id: 'units/list',
          title: 'Browse Units',
          subtitle: 'Units',
          keywords: [],
          kind: 'extension',
          extensionTitle: 'Units',
          categories: []
        }
      ],
      apps: [],
      resolveAlias: () => null
    })
    expect(rows.filter((row) => row.kind === 'extension')).toEqual([
      {
        id: 'extension:units/list#:nginx',
        title: 'nginx',
        subtitle: 'Units · Browse Units',
        kind: 'extension'
      }
    ])
  })

  it('lets an alias reach as deep as a pin, title and all', () => {
    const rows = composeExt(
      'gh',
      '[aliases]\ngh = { id = "extension:1password/search#logins:a1b2!Copy Password", title = "GitHub — Copy Password" }\n'
    )
    expect(rows[0]).toEqual({
      id: 'extension:1password/search#logins:a1b2!Copy Password',
      title: 'GitHub — Copy Password',
      subtitle: '1Password · Logins',
      kind: 'extension'
    })
  })
})

/**
 * The grammar a key, an alias and a pin all share. The action separator is the
 * *last* `!` — see `parseExtensionPin` for why that direction was chosen.
 */
describe('parseExtensionPin', () => {
  it('reads the four shapes', () => {
    expect(parseExtensionPin('ext/cmd')).toBeNull()
    expect(parseExtensionPin('ext/cmd#cat')).toEqual({
      commandId: 'ext/cmd',
      category: 'cat',
      item: null,
      action: null
    })
    expect(parseExtensionPin('ext/cmd#cat:row')).toEqual({
      commandId: 'ext/cmd',
      category: 'cat',
      item: 'row',
      action: null
    })
    expect(parseExtensionPin('ext/cmd#cat:row!Open project')).toEqual({
      commandId: 'ext/cmd',
      category: 'cat',
      item: 'row',
      action: 'Open project'
    })
  })

  it('lets a row id keep its own exclamation mark', () => {
    expect(parseExtensionPin('ext/cmd#cat:we!rd:id!Run')).toEqual({
      commandId: 'ext/cmd',
      category: 'cat',
      item: 'we!rd:id',
      action: 'Run'
    })
  })

  it('allows an empty category, for a command that declares none', () => {
    expect(parseExtensionPin('ext/cmd#:row')).toEqual({
      commandId: 'ext/cmd',
      category: '',
      item: 'row',
      action: null
    })
  })

  it('refuses an action with no row to run it on', () => {
    // Actions belong to rows. A key naming one without a row would resolve into
    // a launch that quietly does nothing, which is worse than being refused.
    expect(parseExtensionPin('ext/cmd#cat!Open project')).toBeNull()
  })
})

describe('[[hotkeys]]', () => {
  it('reads bind/target pairs and validates the target as a pin key', () => {
    const config = loadConfig({
      fileContents:
        '[[hotkeys]]\nbind = "Super+P"\ntarget = "extension:1password/search#logins"\n' +
        '[[hotkeys]]\nbind = "Super+D"\ntarget = "nonsense"\n',
      env: {}
    })
    expect(config.hotkeys.value).toEqual([
      { bind: 'Super+P', target: 'extension:1password/search#logins', title: null }
    ])
    expect(config.problems.some((problem) => problem.includes('Super+D'))).toBe(true)
  })

  it('refuses a target that could escape its future quoting', () => {
    // The target ends up inside a compositor bind line, single-quoted.
    const config = loadConfig({
      fileContents: `[[hotkeys]]\nbind = "Super+X"\ntarget = "shell:echo 'hi'"\n`,
      env: {}
    })
    expect(config.hotkeys.value).toEqual([])
  })
})

/**
 * A command that declared itself off the root.
 *
 * `lumanin.root: false` is filtered where root rows are *made*, so it is absent
 * from the ranking, from pins (they resolve against this list) and from aliases
 * alike — while staying in the index, which is what keeps it launchable by key
 * and manageable in `lumanin plugins`.
 */
describe('lumanin.root: false', () => {
  const index = (): ExtensionIndex => ({
    extensions: [extension('files')],
    problems: [],
    commands: [
      {
        id: 'files/search',
        spec: { ...spec('search', 'Search Files'), root: false },
        entryPath: '',
        extension: extension('files')
      },
      { id: 'notes/list', spec: spec('list', 'List Notes'), entryPath: '', extension: extension('notes') }
    ] as ExtensionIndex['commands']
  })

  it('is not a root row, while everything else still is', () => {
    const rows = extensionRootCommands(index())
    expect(rows.map((row) => row.id)).toEqual(['notes/list'])
  })

  it('stays in the index, so it can still be launched and managed', () => {
    expect(index().commands.map((command) => command.id)).toContain('files/search')
  })
})
