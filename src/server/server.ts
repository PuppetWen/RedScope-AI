import { resolve } from 'path'
import { jsonStringify } from '../utils/slowOperations.js'
import type { ServerConfig } from './types.js'
import type { SessionManager } from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'

type WsData = {
  sessionId: string
}

export type RedScopeSessionServer = {
  port?: number
  stop(closeActiveConnections: boolean): void
}

type CreateSessionBody = {
  cwd?: unknown
  dangerously_skip_permissions?: unknown
}

function isAuthorized(request: Request, authToken: string): boolean {
  const header = request.headers.get('authorization')
  return header === `Bearer ${authToken}`
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  return new Response(jsonStringify(value), {
    ...init,
    headers,
  })
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url)
  const proto =
    request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1)
  const host = request.headers.get('host') ?? url.host
  return `${proto}://${host}`
}

function getWsUrl(request: Request, sessionId: string): string {
  const origin = getRequestOrigin(request)
  const wsOrigin = origin.startsWith('https://')
    ? `wss://${origin.slice('https://'.length)}`
    : `ws://${origin.replace(/^https?:\/\//, '')}`
  return `${wsOrigin}/sessions/${encodeURIComponent(sessionId)}/ws`
}

async function readCreateSessionBody(
  request: Request,
): Promise<CreateSessionBody> {
  if (!request.body) return {}
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return {}
  const body = await request.json().catch(() => ({}))
  return typeof body === 'object' && body !== null ? body : {}
}

function resolveSessionCwd(
  body: CreateSessionBody,
  config: ServerConfig,
): string {
  const requested =
    typeof body.cwd === 'string' && body.cwd.trim()
      ? body.cwd
      : config.workspace
  return resolve(requested ?? process.cwd())
}

export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): RedScopeSessionServer {
  const server = Bun.serve<WsData>({
    ...(config.unix
      ? { unix: config.unix }
      : { hostname: config.host, port: config.port }),
    fetch: async (request, bunServer) => {
      const url = new URL(request.url)

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          product: 'RedScope AI',
          sessions: sessionManager.listSessions().length,
        })
      }

      if (!isAuthorized(request, config.authToken)) {
        return jsonResponse(
          { error: 'Unauthorized' },
          {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          },
        )
      }

      if (request.method === 'GET' && url.pathname === '/sessions') {
        const sessions = sessionManager.listSessions().map(session => {
          const { process: _process, ...safeSession } = session
          return safeSession
        })
        return jsonResponse({ sessions })
      }

      if (request.method === 'POST' && url.pathname === '/sessions') {
        try {
          const body = await readCreateSessionBody(request)
          const session = sessionManager.createSession({
            cwd: resolveSessionCwd(body, config),
            dangerouslySkipPermissions:
              body.dangerously_skip_permissions === true,
          })
          logger.info(`created session ${session.id} cwd=${session.workDir}`)
          return jsonResponse(
            {
              session_id: session.id,
              ws_url: getWsUrl(request, session.id),
              work_dir: session.workDir,
            },
            { status: 201 },
          )
        } catch (error) {
          logger.error('failed to create session', error)
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to create session',
            },
            { status: 500 },
          )
        }
      }

      const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/)
      if (request.method === 'GET' && wsMatch) {
        const sessionId = decodeURIComponent(wsMatch[1]!)
        if (!sessionManager.getSession(sessionId)) {
          return jsonResponse({ error: 'Session not found' }, { status: 404 })
        }
        const upgraded = bunServer.upgrade(request, {
          data: { sessionId },
        })
        if (upgraded) {
          return undefined
        }
        return jsonResponse(
          { error: 'WebSocket upgrade failed' },
          { status: 400 },
        )
      }

      return jsonResponse({ error: 'Not found' }, { status: 404 })
    },
    websocket: {
      open(ws) {
        const attached = sessionManager.attachSocket(ws.data.sessionId, ws)
        if (!attached) {
          ws.close(1008, 'Session not available')
        }
      },
      message(ws, message) {
        const data =
          typeof message === 'string'
            ? message
            : new TextDecoder().decode(message)
        const ok = sessionManager.receiveFromSocket(ws.data.sessionId, data)
        if (!ok) {
          ws.close(1011, 'Session input unavailable')
        }
      },
      close(ws) {
        sessionManager.detachSocket(ws.data.sessionId, ws)
      },
    },
  })

  logger.info(
    config.unix
      ? `listening on unix:${config.unix}`
      : `listening on http://${config.host}:${server.port}`,
  )

  return {
    port: config.unix ? undefined : server.port,
    stop(closeActiveConnections: boolean) {
      server.stop(closeActiveConnections)
    },
  }
}
