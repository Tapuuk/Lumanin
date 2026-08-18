import { describe, expect, it } from 'vitest'
import { allSettings, GLOBAL_HOTKEY, HABIT_LEVELS } from '../src/shared/settings-model'
import { KEY_ACTION_INFO } from '../src/shared/keys'

// The mechanical half of the copy rules: no markdown, no dashes as punctuation,
// no exclamation marks, help ends in a full stop, options are sentence case and
// help never names a config key.
const BANNED = ['`', '*', ' - ', '–', '—', '!']

function expectClean(text: string, where: string): void {
  for (const token of BANNED) {
    expect(text, `${where} contains ${JSON.stringify(token)}`).not.toContain(token)
  }
}

const settings = [GLOBAL_HOTKEY, ...allSettings()]

describe('settings copy', () => {
  it('labels and help carry no markdown, dashes or exclamation marks', () => {
    for (const setting of settings) {
      const where = setting.path.join('.')
      expectClean(setting.label, `${where} label`)
      expectClean(setting.help, `${where} help`)
    }
    for (const level of HABIT_LEVELS) {
      expectClean(level.label, `habit ${level.label} label`)
      expectClean(level.detail, `habit ${level.label} detail`)
    }
    for (const [action, info] of Object.entries(KEY_ACTION_INFO)) {
      expectClean(info.title, `key ${action} title`)
      expectClean(info.help, `key ${action} help`)
    }
  })

  it('help is one or two sentences ending in a full stop', () => {
    const expectHelp = (help: string, where: string): void => {
      expect(help, where).toMatch(/\.$/)
      expect(help.split(/\.\s+/).length, where).toBeLessThanOrEqual(2)
    }
    for (const setting of settings) expectHelp(setting.help, setting.path.join('.'))
    for (const info of Object.values(KEY_ACTION_INFO)) expectHelp(info.help, info.title)
  })

  it('enum options and presets are sentence case and clean', () => {
    for (const setting of settings) {
      const where = setting.path.join('.')
      if (setting.editor.kind === 'enum') {
        for (const option of setting.editor.options) {
          expectClean(option.label, `${where} option ${option.value}`)
          expect(option.label, `${where} option ${option.value}`).toMatch(/^[^a-z]/)
        }
      }
      if (setting.editor.kind === 'number') {
        for (const preset of setting.editor.presets ?? []) {
          expectClean(preset.label, `${where} preset ${preset.label}`)
          expect(preset.label, `${where} preset ${preset.label}`).toMatch(/^[^a-z]/)
          if (preset.detail !== undefined) expectClean(preset.detail, `${where} preset detail`)
        }
      }
    }
  })

  it('help never names a config key', () => {
    for (const setting of settings) {
      const where = setting.path.join('.')
      expect(setting.help, where).not.toContain(setting.path.join('.'))
      for (const segment of setting.path) {
        if (segment.includes('_')) expect(setting.help, where).not.toContain(segment)
      }
    }
  })
})
