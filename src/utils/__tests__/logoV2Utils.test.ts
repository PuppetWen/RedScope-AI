import { describe, expect, test } from 'bun:test'
import {
  calculateCondensedLogoLayout,
  calculateInfoPillValueWidth,
  calculateInfoPillWidth,
  formatModelAndBilling,
} from '../logoV2Utils.js'

describe('logoV2Utils responsive sizing', () => {
  test('keeps condensed logo horizontal only when text has enough room', () => {
    expect(calculateCondensedLogoLayout(60)).toEqual({
      direction: 'row',
      textWidth: 45,
    })
    expect(calculateCondensedLogoLayout(30)).toEqual({
      direction: 'column',
      textWidth: 28,
    })
  })

  test('calculates pill value width from full available row width', () => {
    expect(calculateInfoPillValueWidth(20, 'model')).toBe(11)
    expect(calculateInfoPillValueWidth(4, 'model')).toBe(1)
    expect(calculateInfoPillWidth('cwd', '/tmp')).toBe(11)
  })

  test('splits model and billing based on rendered pill width', () => {
    const result = formatModelAndBilling(
      'claude-sonnet-4-5-with-extra-label',
      'API Usage Billing',
      30,
    )

    expect(result.shouldSplit).toBe(true)
    expect(
      calculateInfoPillWidth('model', result.truncatedModel),
    ).toBeLessThanOrEqual(30)
    expect(
      calculateInfoPillWidth('billing', result.truncatedBilling),
    ).toBeLessThanOrEqual(30)
  })

  test('keeps model and billing on one row when both rendered pills fit', () => {
    const result = formatModelAndBilling('sonnet', 'API', 40)

    expect(result.shouldSplit).toBe(false)
    expect(result.truncatedModel).toBe('sonnet')
    expect(result.truncatedBilling).toBe('API')
  })
})
