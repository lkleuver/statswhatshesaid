import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

const TOKEN = 'config-test-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const noop = async () => {}

describe('resolveConfig persistence', () => {
  it('defaults persistence to null and debounce to 30000', () => {
    const c = resolveConfig({ token: TOKEN })
    expect(c.persistence).toBeNull()
    expect(c.persistSaveDebounceMs).toBe(30000)
  })

  it('accepts a valid persistence object', () => {
    const persistence = { load: async () => null, save: noop }
    const c = resolveConfig({ token: TOKEN, persistence })
    expect(c.persistence).toBe(persistence)
  })

  it('throws when persistence is missing a function', () => {
    expect(() =>
      // @ts-expect-error intentionally invalid
      resolveConfig({ token: TOKEN, persistence: { load: async () => null } }),
    ).toThrow(/load.*save/)
  })

  it('honors a custom persistSaveDebounceMs', () => {
    const c = resolveConfig({ token: TOKEN, persistSaveDebounceMs: 5000 })
    expect(c.persistSaveDebounceMs).toBe(5000)
  })

  it('rejects a negative persistSaveDebounceMs', () => {
    expect(() =>
      resolveConfig({ token: TOKEN, persistSaveDebounceMs: -1 }),
    ).toThrow(/persistSaveDebounceMs/)
  })
})
