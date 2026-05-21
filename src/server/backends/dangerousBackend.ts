import type { ChildProcess } from 'child_process'
import { buildCliLaunch, spawnCli } from '../../utils/cliLaunch.js'

export type BackendSessionOptions = {
  sessionId: string
  cwd: string
  dangerouslySkipPermissions?: boolean
}

export type BackendSession = {
  process: ChildProcess
  stderrTail: string[]
}

const STDERR_TAIL_LINES = 40

export class DangerousBackend {
  createSession(options: BackendSessionOptions): BackendSession {
    const cliArgs = [
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--session-id',
      options.sessionId,
      '-p',
    ]

    if (options.dangerouslySkipPermissions) {
      cliArgs.push('--dangerously-skip-permissions')
    }

    const spec = buildCliLaunch(cliArgs)
    const child = spawnCli(spec, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...spec.env,
        CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      },
    })

    const stderrTail: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue
        stderrTail.push(line)
      }
      if (stderrTail.length > STDERR_TAIL_LINES) {
        stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES)
      }
    })

    return { process: child, stderrTail }
  }
}
