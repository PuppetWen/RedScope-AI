import { afterEach, describe, expect, test } from 'bun:test'
import {
  LEGACY_BRIDGE_BASE_URL_ENV,
  LEGACY_BRIDGE_OAUTH_TOKEN_ENV,
  LEGACY_BRIDGE_SESSION_INGRESS_URL_ENV,
  LEGACY_BRIDGE_USE_CCR_V2_ENV,
  REDSCOPE_BRIDGE_BASE_URL_ENV,
  REDSCOPE_BRIDGE_OAUTH_TOKEN_ENV,
  REDSCOPE_BRIDGE_SESSION_INGRESS_URL_ENV,
  REDSCOPE_BRIDGE_USE_CCR_V2_ENV,
  getBridgeBaseUrlOverrideEnv,
  getBridgeSessionIngressUrl,
  getBridgeTokenOverrideEnv,
  isBridgeCcrV2OverrideEnabled,
} from '../bridgeEnv'

const ENV_KEYS = [
  REDSCOPE_BRIDGE_BASE_URL_ENV,
  LEGACY_BRIDGE_BASE_URL_ENV,
  REDSCOPE_BRIDGE_OAUTH_TOKEN_ENV,
  LEGACY_BRIDGE_OAUTH_TOKEN_ENV,
  REDSCOPE_BRIDGE_SESSION_INGRESS_URL_ENV,
  LEGACY_BRIDGE_SESSION_INGRESS_URL_ENV,
  REDSCOPE_BRIDGE_USE_CCR_V2_ENV,
  LEGACY_BRIDGE_USE_CCR_V2_ENV,
]

const previousEnv = new Map<string, string | undefined>()

for (const key of ENV_KEYS) {
  previousEnv.set(key, process.env[key])
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('bridgeEnv', () => {
  test('prefers RedScope bridge overrides over legacy aliases', () => {
    process.env[REDSCOPE_BRIDGE_BASE_URL_ENV] = 'https://redscope.example'
    process.env[LEGACY_BRIDGE_BASE_URL_ENV] = 'https://legacy.example'
    process.env[REDSCOPE_BRIDGE_OAUTH_TOKEN_ENV] = 'redscope-token'
    process.env[LEGACY_BRIDGE_OAUTH_TOKEN_ENV] = 'legacy-token'

    expect(getBridgeBaseUrlOverrideEnv()).toBe('https://redscope.example')
    expect(getBridgeTokenOverrideEnv()).toBe('redscope-token')
  })

  test('keeps legacy bridge aliases for existing deployments', () => {
    process.env[LEGACY_BRIDGE_BASE_URL_ENV] = 'https://legacy.example'
    process.env[LEGACY_BRIDGE_OAUTH_TOKEN_ENV] = 'legacy-token'
    process.env[LEGACY_BRIDGE_SESSION_INGRESS_URL_ENV] =
      'wss://legacy-ingress.example'
    process.env[LEGACY_BRIDGE_USE_CCR_V2_ENV] = '1'

    expect(getBridgeBaseUrlOverrideEnv()).toBe('https://legacy.example')
    expect(getBridgeTokenOverrideEnv()).toBe('legacy-token')
    expect(getBridgeSessionIngressUrl('https://base.example')).toBe(
      'wss://legacy-ingress.example',
    )
    expect(isBridgeCcrV2OverrideEnabled()).toBe(true)
  })

  test('uses RedScope session ingress override and falls back to base URL', () => {
    expect(getBridgeSessionIngressUrl('https://base.example')).toBe(
      'https://base.example',
    )

    process.env[REDSCOPE_BRIDGE_SESSION_INGRESS_URL_ENV] =
      'wss://redscope-ingress.example'

    expect(getBridgeSessionIngressUrl('https://base.example')).toBe(
      'wss://redscope-ingress.example',
    )
  })
})
