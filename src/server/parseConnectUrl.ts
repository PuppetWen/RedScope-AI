export type ParsedConnectUrl = {
  serverUrl: string
  authToken: string
}

function tokenFrom(url: URL): string {
  return (
    url.searchParams.get('token') ??
    url.searchParams.get('authToken') ??
    url.password ??
    ''
  )
}

function normalizeHttpUrl(raw: string): ParsedConnectUrl {
  const url = new URL(raw)
  const authToken = tokenFrom(url)
  url.username = ''
  url.password = ''
  url.searchParams.delete('token')
  url.searchParams.delete('authToken')
  url.hash = ''
  url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  url.search = ''
  return {
    serverUrl: url.toString().replace(/\/$/, ''),
    authToken,
  }
}

export function parseConnectUrl(raw: string): ParsedConnectUrl {
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return normalizeHttpUrl(raw)
  }

  if (raw.startsWith('cc+unix://')) {
    throw new Error(
      'cc+unix direct-connect URLs are not supported by this client path yet. Start the server on TCP with --host/--port and use the cc:// URL from the banner.',
    )
  }

  if (!raw.startsWith('cc://')) {
    throw new Error(`Unsupported RedScope direct-connect URL: ${raw}`)
  }

  const ccUrl = new URL(raw)
  if (!ccUrl.host) {
    throw new Error(`Invalid RedScope direct-connect URL: ${raw}`)
  }

  const authToken = tokenFrom(ccUrl)
  const serverUrl =
    `http://${ccUrl.host}${ccUrl.pathname === '/' ? '' : ccUrl.pathname}`.replace(
      /\/$/,
      '',
    )
  return {
    serverUrl,
    authToken,
  }
}
