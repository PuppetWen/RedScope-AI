export type ServerLogger = {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

function formatError(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error) {
    return `: ${error.message}`
  }
  return `: ${String(error)}`
}

export function createServerLogger(): ServerLogger {
  return {
    info(message: string) {
      process.stderr.write(`[redscope-server] ${message}\n`)
    },
    warn(message: string) {
      process.stderr.write(`[redscope-server] warning: ${message}\n`)
    },
    error(message: string, error?: unknown) {
      process.stderr.write(
        `[redscope-server] error: ${message}${formatError(error)}\n`,
      )
    },
  }
}
