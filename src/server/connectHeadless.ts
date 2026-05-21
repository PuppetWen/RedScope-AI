import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'

type OutputFormat = 'text' | 'json' | 'stream-json'

function normalizeOutputFormat(value: string | undefined): OutputFormat {
  if (value === 'json' || value === 'stream-json' || value === 'text') {
    return value
  }
  return 'text'
}

async function readStdinIfAvailable(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

function userMessageLine(prompt: string): string {
  return jsonStringify({
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
    parent_tool_use_id: null,
    session_id: '',
  })
}

function denyPermissionLine(requestId: string): string {
  return jsonStringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'deny',
        message:
          'Headless direct-connect mode cannot approve tool permission prompts.',
      },
    },
  })
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof Blob) return await data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data)
  }
  return String(data)
}

function getResultText(message: Record<string, unknown>): string | undefined {
  return typeof message.result === 'string' ? message.result : undefined
}

export async function runConnectHeadless(
  config: DirectConnectConfig,
  promptArg: string,
  outputFormatArg: string | undefined,
  _interactive: boolean,
): Promise<void> {
  const outputFormat = normalizeOutputFormat(outputFormatArg)
  const prompt = promptArg.trim() || (await readStdinIfAvailable())
  if (!prompt) {
    throw new Error(
      'Input must be provided either through stdin or as a prompt argument when using direct-connect print mode',
    )
  }

  const headers: Record<string, string> = {}
  if (config.authToken) {
    headers.authorization = `Bearer ${config.authToken}`
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(config.wsUrl, { headers } as unknown as string[])
    let buffer = ''
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // Already closed.
      }
      if (error) reject(error)
      else resolve()
    }

    ws.addEventListener('open', () => {
      ws.send(userMessageLine(prompt))
    })

    ws.addEventListener('message', event => {
      void (async () => {
        buffer += await toText(event.data)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (outputFormat === 'stream-json') {
            process.stdout.write(`${trimmed}\n`)
          }

          let parsed: unknown
          try {
            parsed = jsonParse(trimmed)
          } catch {
            continue
          }
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('type' in parsed)
          ) {
            continue
          }
          const message = parsed as Record<string, unknown>

          if (message.type === 'control_request') {
            const requestId =
              typeof message.request_id === 'string'
                ? message.request_id
                : undefined
            if (requestId) {
              ws.send(denyPermissionLine(requestId))
            }
            continue
          }

          if (message.type === 'result') {
            if (outputFormat === 'json') {
              process.stdout.write(`${jsonStringify(message)}\n`)
            } else if (outputFormat === 'text') {
              const result = getResultText(message)
              if (result) process.stdout.write(`${result}\n`)
            }
            finish()
          }
        }
      })().catch(error =>
        finish(error instanceof Error ? error : new Error(String(error))),
      )
    })

    ws.addEventListener('error', () => {
      finish(new Error(`WebSocket connection failed: ${config.wsUrl}`))
    })

    ws.addEventListener('close', () => {
      finish()
    })
  })
}
