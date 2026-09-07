import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstRunPending, markFirstRunOffered } from '../src/node/first-run'

/**
 * The first-run offer fires from two doors — the daemon on the panel's first
 * show, the CLI on an interactive terminal — and this helper is the one answer
 * both read. What matters is that it says yes exactly once per machine, however
 * setup then happens.
 */
describe('firstRunPending', () => {
  const fresh = (): { configFile: string; stateDir: string } => {
    const root = mkdtempSync(join(tmpdir(), 'lumanin-first-run-'))
    return { configFile: join(root, 'config.toml'), stateDir: join(root, 'state') }
  }

  it('is pending on a machine with nothing at all', () => {
    const { configFile, stateDir } = fresh()
    expect(firstRunPending(configFile, stateDir)).toBe(true)
  })

  it('is settled the moment config.toml exists, however it got there', () => {
    const { configFile, stateDir } = fresh()
    writeFileSync(configFile, '')
    expect(firstRunPending(configFile, stateDir)).toBe(false)
  })

  it('is settled once the wizard finished, even with no config written', () => {
    const { configFile, stateDir } = fresh()
    markFirstRunOffered(stateDir) // creates the state dir
    writeFileSync(join(stateDir, 'first-run-done'), '')
    expect(firstRunPending(configFile, stateDir)).toBe(false)
  })

  it('never asks twice: one offer marks it settled for both doors', () => {
    const { configFile, stateDir } = fresh()
    expect(firstRunPending(configFile, stateDir)).toBe(true)
    markFirstRunOffered(stateDir)
    expect(firstRunPending(configFile, stateDir)).toBe(false)
  })

  it('creates the state directory on the way to the marker', () => {
    const { stateDir } = fresh()
    expect(existsSync(stateDir)).toBe(false)
    markFirstRunOffered(stateDir)
    expect(readFileSync(join(stateDir, 'first-run-offered'), 'utf8')).toMatch(/T/)
  })
})
