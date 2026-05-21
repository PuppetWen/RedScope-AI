import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { formatRemoteControlLocalStatus } from '../remoteControlStatus'

let previousBaseUrl: string | undefined
let previousToken: string | undefined
let previousLegacyBaseUrl: string | undefined
let previousLegacyToken: string | undefined

beforeEach(() => {
  previousBaseUrl = process.env.REDSCOPE_BRIDGE_BASE_URL
  previousToken = process.env.REDSCOPE_BRIDGE_OAUTH_TOKEN
  previousLegacyBaseUrl = process.env.CLAUDE_BRIDGE_BASE_URL
  previousLegacyToken = process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
})

afterEach(() => {
  if (previousBaseUrl === undefined) {
    delete process.env.REDSCOPE_BRIDGE_BASE_URL
  } else {
    process.env.REDSCOPE_BRIDGE_BASE_URL = previousBaseUrl
  }
  if (previousToken === undefined) {
    delete process.env.REDSCOPE_BRIDGE_OAUTH_TOKEN
  } else {
    process.env.REDSCOPE_BRIDGE_OAUTH_TOKEN = previousToken
  }
  if (previousLegacyBaseUrl === undefined) {
    delete process.env.CLAUDE_BRIDGE_BASE_URL
  } else {
    process.env.CLAUDE_BRIDGE_BASE_URL = previousLegacyBaseUrl
  }
  if (previousLegacyToken === undefined) {
    delete process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
  } else {
    process.env.CLAUDE_BRIDGE_OAUTH_TOKEN = previousLegacyToken
  }
})

describe('remote control status', () => {
  test('formats self-hosted bridge local config without remote calls', () => {
    process.env.REDSCOPE_BRIDGE_BASE_URL = 'http://127.0.0.1:8787'
    process.env.REDSCOPE_BRIDGE_OAUTH_TOKEN = 'token'

    const status = formatRemoteControlLocalStatus()

    expect(status).toContain('Remote Control: self-hosted')
    expect(status).toContain('base_url=http://127.0.0.1:8787')
    expect(status).toContain('token=present')
    expect(status).toContain('entitlement=checked at remote-control startup')
  })
})
