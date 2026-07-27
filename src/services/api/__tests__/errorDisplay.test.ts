import { describe, expect, test } from 'bun:test'
import { summarizeApiErrorForDisplay } from '../errors'

describe('summarizeApiErrorForDisplay', () => {
  test('summarizes an OpenAI-compatible JSON envelope', () => {
    const text =
      'API Error: 402 {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}'

    expect(summarizeApiErrorForDisplay(text)).toBe(
      'API Error 402 · Insufficient Balance (invalid_request_error)',
    )
  })

  test('keeps a login hint and accepts a top-level error shape', () => {
    const text =
      'Please run /login · API Error: 401 {"message":"Token expired"}'

    expect(summarizeApiErrorForDisplay(text)).toBe(
      'Please run /login · API Error 401 · Token expired',
    )
  })

  test('falls back to the original renderer for malformed or unrelated text', () => {
    expect(summarizeApiErrorForDisplay('API Error: 500 {bad json}')).toBeNull()
    expect(summarizeApiErrorForDisplay('ordinary assistant text')).toBeNull()
  })
})
