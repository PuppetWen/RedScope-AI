import { randomUUID } from 'crypto'
import type { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { resolve } from 'path'
import type {
  BackendSession,
  BackendSessionOptions,
  DangerousBackend,
} from './backends/dangerousBackend.js'
import type { SessionInfo, SessionState } from './types.js'

type SocketLike = {
  send(data: string): unknown
  close(code?: number, reason?: string): void
}

type SessionRecord = Omit<SessionInfo, 'process'> & {
  process: ChildProcess
  backendSession: BackendSession
  sockets: Set<SocketLike>
  idleTimer: NodeJS.Timeout | null
  stderrTail: string[]
}

export type SessionManagerOptions = {
  idleTimeoutMs?: number
  maxSessions?: number
}

export type CreateSessionRequest = {
  cwd: string
  dangerouslySkipPermissions?: boolean
}

export class SessionManager {
  private readonly backend: DangerousBackend
  private readonly idleTimeoutMs: number
  private readonly maxSessions: number
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(backend: DangerousBackend, options: SessionManagerOptions = {}) {
    this.backend = backend
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 600_000)
    this.maxSessions = Math.max(0, options.maxSessions ?? 32)
  }

  createSession(request: CreateSessionRequest): SessionInfo {
    this.enforceSessionLimit()

    const id = randomUUID()
    const workDir = resolve(request.cwd)
    const backendOptions: BackendSessionOptions = {
      sessionId: id,
      cwd: workDir,
      dangerouslySkipPermissions: request.dangerouslySkipPermissions,
    }
    const backendSession = this.backend.createSession(backendOptions)
    const record: SessionRecord = {
      id,
      status: 'starting',
      createdAt: Date.now(),
      workDir,
      process: backendSession.process,
      backendSession,
      sockets: new Set(),
      idleTimer: null,
      stderrTail: backendSession.stderrTail,
    }

    this.sessions.set(id, record)
    this.pipeChildOutput(record)
    this.watchChildExit(record)

    return this.toInfo(record)
  }

  getSession(id: string): SessionInfo | undefined {
    const record = this.sessions.get(id)
    return record ? this.toInfo(record) : undefined
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map(record => this.toInfo(record))
  }

  attachSocket(id: string, socket: SocketLike): boolean {
    const record = this.sessions.get(id)
    if (
      !record ||
      record.status === 'stopped' ||
      record.status === 'stopping'
    ) {
      return false
    }

    if (record.idleTimer) {
      clearTimeout(record.idleTimer)
      record.idleTimer = null
    }
    record.sockets.add(socket)
    record.status = 'running'
    return true
  }

  detachSocket(id: string, socket: SocketLike): void {
    const record = this.sessions.get(id)
    if (!record) return

    record.sockets.delete(socket)
    if (
      record.sockets.size === 0 &&
      record.status !== 'stopped' &&
      record.status !== 'stopping'
    ) {
      record.status = 'detached'
      this.scheduleIdleStop(record)
    }
  }

  receiveFromSocket(id: string, data: string): boolean {
    const record = this.sessions.get(id)
    if (!record || !record.process.stdin || record.process.stdin.destroyed) {
      return false
    }

    record.process.stdin.write(data.endsWith('\n') ? data : `${data}\n`)
    return true
  }

  stopSession(id: string): boolean {
    const record = this.sessions.get(id)
    if (!record) return false

    this.stopRecord(record, 'Session stopped')
    return true
  }

  async destroyAll(): Promise<void> {
    const records = [...this.sessions.values()]
    for (const record of records) {
      this.stopRecord(record, 'Server shutting down')
    }
    await Promise.all(
      records.map(
        record =>
          new Promise<void>(resolveClose => {
            if (record.process.exitCode !== null || record.process.killed) {
              resolveClose()
              return
            }
            record.process.once('close', () => resolveClose())
            setTimeout(resolveClose, 1_000).unref()
          }),
      ),
    )
  }

  private enforceSessionLimit(): void {
    if (this.maxSessions === 0) return
    const active = [...this.sessions.values()].filter(
      record => record.status !== 'stopped',
    )
    if (active.length >= this.maxSessions) {
      throw new Error(`Maximum session limit reached (${this.maxSessions})`)
    }
  }

  private pipeChildOutput(record: SessionRecord): void {
    record.process.stdout?.setEncoding('utf8')
    if (record.process.stdout) {
      const rl = createInterface({ input: record.process.stdout })
      rl.on('line', line => {
        if (record.status === 'starting') {
          record.status = record.sockets.size > 0 ? 'running' : 'detached'
        }
        this.broadcast(record, `${line}\n`)
      })
      rl.on('close', () => {
        if (record.sockets.size === 0 && record.status === 'running') {
          record.status = 'detached'
        }
      })
    }
  }

  private watchChildExit(record: SessionRecord): void {
    record.process.once('close', () => {
      record.status = 'stopped'
      if (record.idleTimer) {
        clearTimeout(record.idleTimer)
        record.idleTimer = null
      }
      for (const socket of record.sockets) {
        socket.close(1000, 'Session process exited')
      }
      record.sockets.clear()
      setTimeout(() => {
        this.sessions.delete(record.id)
      }, 30_000).unref()
    })
  }

  private scheduleIdleStop(record: SessionRecord): void {
    if (this.idleTimeoutMs === 0 || record.idleTimer) return
    record.idleTimer = setTimeout(() => {
      record.idleTimer = null
      if (record.sockets.size === 0 && record.status === 'detached') {
        this.stopRecord(record, 'Session idle timeout')
      }
    }, this.idleTimeoutMs)
    record.idleTimer.unref()
  }

  private stopRecord(record: SessionRecord, reason: string): void {
    if (record.status === 'stopped' || record.status === 'stopping') return

    record.status = 'stopping'
    if (record.idleTimer) {
      clearTimeout(record.idleTimer)
      record.idleTimer = null
    }
    for (const socket of record.sockets) {
      socket.close(1000, reason)
    }
    record.sockets.clear()
    if (!record.process.killed) {
      record.process.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    }
  }

  private broadcast(record: SessionRecord, data: string): void {
    for (const socket of record.sockets) {
      try {
        socket.send(data)
      } catch {
        record.sockets.delete(socket)
      }
    }
  }

  private toInfo(record: SessionRecord): SessionInfo {
    return {
      id: record.id,
      status: record.status as SessionState,
      createdAt: record.createdAt,
      workDir: record.workDir,
      process: record.process,
      sessionKey: record.sessionKey,
    }
  }
}
