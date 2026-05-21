/**
 * Shared bridge auth/URL resolution. Consolidates the RedScope bridge
 * env overrides that were previously copy-pasted across
 * a dozen files — inboundAttachments, BriefTool/upload, bridgeMain,
 * initReplBridge, remoteBridgeCore, daemon workers, /rename,
 * /remote-control.
 *
 * RedScope env vars are primary. Legacy CLAUDE_BRIDGE_* names remain accepted
 * for existing deployments.
 *
 * Two layers: *Override() returns the env override (or undefined);
 * the non-Override versions fall through to the real OAuth store/config.
 * Callers that compose with a different auth source (e.g. daemon workers
 * using IPC auth) use the Override getters directly.
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'
import {
  getBridgeBaseUrlOverrideEnv,
  getBridgeTokenOverrideEnv,
} from './bridgeEnv.js'

/** Dev override: REDSCOPE_BRIDGE_OAUTH_TOKEN, else legacy alias, else undefined. */
export function getBridgeTokenOverride(): string | undefined {
  return getBridgeTokenOverrideEnv()
}

/** Dev override: REDSCOPE_BRIDGE_BASE_URL, else legacy alias, else undefined. */
export function getBridgeBaseUrlOverride(): string | undefined {
  return getBridgeBaseUrlOverrideEnv()
}

/**
 * Access token for bridge API calls: dev override first, then the OAuth
 * keychain. Undefined means "not logged in".
 */
export function getBridgeAccessToken(): string | undefined {
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * Base URL for bridge API calls: dev override first, then the production
 * OAuth config. Always returns a URL.
 */
export function getBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}

/** True when the user has explicitly configured a custom bridge server. */
export function isSelfHostedBridge(): boolean {
  return !!getBridgeBaseUrlOverride()
}
