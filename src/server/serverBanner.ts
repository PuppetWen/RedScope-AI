import type { ServerConfig } from './types.js'

function localConnectHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function printBanner(
  config: ServerConfig,
  authToken: string,
  actualPort: number,
): void {
  if (config.unix) {
    process.stderr.write(
      [
        'RedScope AI session server is running.',
        `Endpoint: unix:${config.unix}`,
        'TCP direct-connect clients are required for interactive connect/open right now.',
        '',
      ].join('\n'),
    )
    return
  }

  const host = localConnectHost(config.host)
  const url = `cc://${host}:${actualPort}?token=${encodeURIComponent(authToken)}`
  process.stderr.write(
    [
      'RedScope AI session server is running.',
      `HTTP: http://${config.host}:${actualPort}`,
      `Connect: redscope ${url}`,
      `Headless: redscope ${url} -p "say hello" --output-format stream-json`,
      'Keep this token private; it grants access to this local server.',
      '',
    ].join('\n'),
  )
}
