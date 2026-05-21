import { isEnvTruthy } from '../utils/envUtils.js'

export const REDSCOPE_BRIDGE_BASE_URL_ENV = 'REDSCOPE_BRIDGE_BASE_URL'
export const LEGACY_BRIDGE_BASE_URL_ENV = 'CLAUDE_BRIDGE_BASE_URL'
export const REDSCOPE_BRIDGE_OAUTH_TOKEN_ENV = 'REDSCOPE_BRIDGE_OAUTH_TOKEN'
export const LEGACY_BRIDGE_OAUTH_TOKEN_ENV = 'CLAUDE_BRIDGE_OAUTH_TOKEN'
export const REDSCOPE_BRIDGE_SESSION_INGRESS_URL_ENV =
  'REDSCOPE_BRIDGE_SESSION_INGRESS_URL'
export const LEGACY_BRIDGE_SESSION_INGRESS_URL_ENV =
  'CLAUDE_BRIDGE_SESSION_INGRESS_URL'
export const REDSCOPE_BRIDGE_USE_CCR_V2_ENV = 'REDSCOPE_BRIDGE_USE_CCR_V2'
export const LEGACY_BRIDGE_USE_CCR_V2_ENV = 'CLAUDE_BRIDGE_USE_CCR_V2'

export function getRedScopeEnvWithLegacy(
  primaryName: string,
  legacyName: string,
): string | undefined {
  return process.env[primaryName] || process.env[legacyName] || undefined
}

export function getBridgeBaseUrlOverrideEnv(): string | undefined {
  return getRedScopeEnvWithLegacy(
    REDSCOPE_BRIDGE_BASE_URL_ENV,
    LEGACY_BRIDGE_BASE_URL_ENV,
  )
}

export function getBridgeTokenOverrideEnv(): string | undefined {
  return getRedScopeEnvWithLegacy(
    REDSCOPE_BRIDGE_OAUTH_TOKEN_ENV,
    LEGACY_BRIDGE_OAUTH_TOKEN_ENV,
  )
}

export function getBridgeSessionIngressUrl(baseUrl: string): string {
  return (
    getRedScopeEnvWithLegacy(
      REDSCOPE_BRIDGE_SESSION_INGRESS_URL_ENV,
      LEGACY_BRIDGE_SESSION_INGRESS_URL_ENV,
    ) ?? baseUrl
  )
}

export function isBridgeCcrV2OverrideEnabled(): boolean {
  return (
    isEnvTruthy(process.env[REDSCOPE_BRIDGE_USE_CCR_V2_ENV]) ||
    isEnvTruthy(process.env[LEGACY_BRIDGE_USE_CCR_V2_ENV])
  )
}
