import { describe, expect, it } from 'vitest'
import { resolveTablePrefix } from './capture-validation-messages.mjs'

describe('resolveTablePrefix', () => {
  it("defaults to the CI role's namespace", () => {
    expect(resolveTablePrefix([])).toBe('_conformance_capdrift')
  })

  it('takes a local _capture_ prefix', () => {
    expect(resolveTablePrefix(['--no-tables', '--table-prefix=_capture_20260928_scancap'])).toBe(
      '_capture_20260928_scancap',
    )
  })

  it('refuses a prefix neither cleanup sweeps', () => {
    // Nothing would ever reap a table stranded under these if a run died
    // before its own teardown.
    for (const prefix of ['scratch', '_captured_x', 'capture_x', '']) {
      expect(() => resolveTablePrefix([`--table-prefix=${prefix}`])).toThrow(/must start with/)
    }
  })
})
