import { describe, expect, test } from 'bun:test'
import { formatAutoModeAvailability } from '../autonomyStatus'

describe('formatAutoModeAvailability', () => {
  test('reports unavailable when a reason is present', () => {
    expect(formatAutoModeAvailability(true, 'model')).toContain(
      'Auto mode: unavailable',
    )
    expect(formatAutoModeAvailability(true, 'model')).toContain('reason=model')
  })

  test('reports unavailable when the gate is disabled', () => {
    expect(formatAutoModeAvailability(false, null)).toBe(
      ['Auto mode: unavailable', '  reason=gate-disabled'].join('\n'),
    )
  })
})
