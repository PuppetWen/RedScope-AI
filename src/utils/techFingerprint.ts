/**
 * Lightweight HTTP tech / product fingerprinting for engagement targets.
 *
 * Extracts product hints from response headers, body signatures, cookies and
 * URL paths, then maps them onto local PoC / n-day catalog entries so the
 * operator (or full-access autonomy loop) can pull relevant references without
 * claiming a vulnerability from a version string alone.
 */

export type FingerprintSignal = {
  kind: 'header' | 'body' | 'cookie' | 'path' | 'title'
  key: string
  value: string
  product: string
  confidence: number
}

export type TechFingerprint = {
  url?: string
  products: string[]
  signals: FingerprintSignal[]
  rawHeaders?: Record<string, string>
  statusCode?: number
  title?: string
  server?: string
}

export type HttpFingerprintInput = {
  url?: string
  statusCode?: number
  headers?: Record<string, string | string[] | undefined>
  body?: string
  finalUrl?: string
}

type Rule = {
  product: string
  kind: FingerprintSignal['kind']
  /** header name or cookie name when kind is header/cookie */
  key?: string
  pattern: RegExp
  confidence: number
}

const RULES: Rule[] = [
  { product: 'Apache HTTP Server', kind: 'header', key: 'server', pattern: /apache\/?([\d.]+)?/i, confidence: 0.8 },
  { product: 'nginx', kind: 'header', key: 'server', pattern: /nginx\/?([\d.]+)?/i, confidence: 0.8 },
  { product: 'Microsoft IIS', kind: 'header', key: 'server', pattern: /microsoft-iis\/?([\d.]+)?/i, confidence: 0.85 },
  { product: 'OpenResty', kind: 'header', key: 'server', pattern: /openresty/i, confidence: 0.7 },
  { product: 'Cloudflare', kind: 'header', key: 'server', pattern: /cloudflare/i, confidence: 0.6 },
  { product: 'Apache Tomcat', kind: 'header', key: 'server', pattern: /tomcat\/?([\d.]+)?/i, confidence: 0.85 },
  { product: 'Apache Tomcat', kind: 'body', pattern: /Apache Tomcat/i, confidence: 0.9 },
  { product: 'PHP', kind: 'header', key: 'x-powered-by', pattern: /php\/?([\d.]+)?/i, confidence: 0.75 },
  { product: 'ASP.NET', kind: 'header', key: 'x-powered-by', pattern: /asp\.net/i, confidence: 0.8 },
  { product: 'ASP.NET', kind: 'header', key: 'x-aspnet-version', pattern: /.+/i, confidence: 0.85 },
  { product: 'Express', kind: 'header', key: 'x-powered-by', pattern: /express/i, confidence: 0.7 },
  { product: 'Laravel', kind: 'cookie', key: 'laravel_session', pattern: /.+/i, confidence: 0.9 },
  { product: 'Laravel', kind: 'body', pattern: /laravel_session|Ignition|Whoops\\\\Exception/i, confidence: 0.7 },
  { product: 'Django', kind: 'cookie', key: 'csrftoken', pattern: /.+/i, confidence: 0.55 },
  { product: 'Django', kind: 'header', key: 'x-frame-options', pattern: /.+/i, confidence: 0.2 },
  { product: 'WordPress', kind: 'body', pattern: /wp-content|wp-includes|wordpress/i, confidence: 0.85 },
  { product: 'WordPress', kind: 'path', pattern: /\/wp-admin|\/wp-login\.php/i, confidence: 0.9 },
  { product: 'Drupal', kind: 'header', key: 'x-generator', pattern: /drupal/i, confidence: 0.9 },
  { product: 'Drupal', kind: 'body', pattern: /Drupal\.settings|drupal\.js/i, confidence: 0.8 },
  { product: 'Joomla', kind: 'body', pattern: /joomla|\/media\/jui\//i, confidence: 0.75 },
  { product: 'Jenkins', kind: 'header', key: 'x-jenkins', pattern: /.+/i, confidence: 0.95 },
  { product: 'Jenkins', kind: 'body', pattern: /Jenkins ver\.|X-Jenkins/i, confidence: 0.9 },
  { product: 'GitLab', kind: 'body', pattern: /GitLab|gon\.gitlab/i, confidence: 0.85 },
  { product: 'Grafana', kind: 'body', pattern: /grafana/i, confidence: 0.8 },
  { product: 'Grafana', kind: 'header', key: 'server', pattern: /grafana/i, confidence: 0.7 },
  { product: 'Atlassian Confluence', kind: 'body', pattern: /confluence|AJS\.Meta/i, confidence: 0.85 },
  { product: 'Atlassian Jira', kind: 'body', pattern: /JIRA|jira\.webresources/i, confidence: 0.85 },
  { product: 'Microsoft Exchange Server', kind: 'header', key: 'server', pattern: /outlook|exchange/i, confidence: 0.7 },
  { product: 'Microsoft Exchange Server', kind: 'body', pattern: /OutlookWebApp|\/owa\//i, confidence: 0.9 },
  { product: 'Microsoft Exchange Server', kind: 'path', pattern: /\/owa\/|\/ecp\//i, confidence: 0.9 },
  { product: 'Fortinet FortiOS', kind: 'body', pattern: /FortiGate|FortiOS|fgt_lang/i, confidence: 0.9 },
  { product: 'Fortinet FortiOS SSL VPN', kind: 'body', pattern: /sslvpn|fgtauth/i, confidence: 0.8 },
  { product: 'Citrix ADC / NetScaler Gateway', kind: 'body', pattern: /Citrix|Netscaler|NSC_/i, confidence: 0.85 },
  { product: 'F5 BIG-IP', kind: 'body', pattern: /BIG-IP|F5 Networks|TMOS/i, confidence: 0.85 },
  { product: 'F5 BIG-IP', kind: 'cookie', key: 'BIGipServer', pattern: /.+/i, confidence: 0.9 },
  { product: 'Palo Alto PAN-OS', kind: 'body', pattern: /Panorama|GlobalProtect|PAN_HELP/i, confidence: 0.85 },
  { product: 'VMware vCenter', kind: 'body', pattern: /VMware vSphere|vCenter/i, confidence: 0.9 },
  { product: 'Spring Framework', kind: 'header', key: 'x-application-context', pattern: /.+/i, confidence: 0.7 },
  { product: 'Spring Framework', kind: 'body', pattern: /Whitelabel Error Page|spring-boot/i, confidence: 0.8 },
  { product: 'Apache Struts 2', kind: 'body', pattern: /struts|actionerrors/i, confidence: 0.6 },
  { product: 'WebLogic', kind: 'body', pattern: /WebLogic|\/console\/login/i, confidence: 0.85 },
  { product: 'WebLogic', kind: 'header', key: 'server', pattern: /WebLogic/i, confidence: 0.9 },
  { product: 'RabbitMQ', kind: 'body', pattern: /RabbitMQ Management/i, confidence: 0.9 },
  { product: 'Redis', kind: 'body', pattern: /-ERR wrong number of arguments|redis_version/i, confidence: 0.7 },
  { product: 'Elasticsearch', kind: 'body', pattern: /"cluster_name"|lucene_version|You Know, for Search/i, confidence: 0.85 },
  { product: 'Kibana', kind: 'body', pattern: /kibana|kbn-name/i, confidence: 0.8 },
  { product: 'Apache Solr', kind: 'body', pattern: /SolrAdmin|Apache Solr/i, confidence: 0.85 },
  { product: 'ThinkPHP', kind: 'body', pattern: /ThinkPHP|think_template/i, confidence: 0.85 },
  { product: 'Nacos', kind: 'body', pattern: /Nacos|nacos\.css/i, confidence: 0.9 },
  { product: 'Apache Dubbo', kind: 'body', pattern: /dubbo/i, confidence: 0.5 },
  { product: 'Shiro', kind: 'cookie', key: 'rememberMe', pattern: /.+/i, confidence: 0.7 },
  { product: 'Shiro', kind: 'header', key: 'set-cookie', pattern: /rememberMe=/i, confidence: 0.75 },
]

function headerMap(
  headers?: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

function pushUnique(products: string[], product: string): void {
  if (!products.some(p => p.toLowerCase() === product.toLowerCase())) {
    products.push(product)
  }
}

/**
 * Derive a tech fingerprint from an HTTP response snapshot.
 */
export function fingerprintHttpResponse(
  input: HttpFingerprintInput,
): TechFingerprint {
  const headers = headerMap(input.headers)
  const body = input.body ?? ''
  const url = input.finalUrl ?? input.url ?? ''
  const signals: FingerprintSignal[] = []
  const products: string[] = []

  const titleMatch = body.match(/<title[^>]*>([^<]{1,120})<\/title>/i)
  const title = titleMatch?.[1]?.trim()

  for (const rule of RULES) {
    let matched = false
    let value = ''
    if (rule.kind === 'header' && rule.key) {
      const hv = headers[rule.key.toLowerCase()]
      if (hv && rule.pattern.test(hv)) {
        matched = true
        value = hv
      }
      // also scan all set-cookie / server-like headers when key is set-cookie
      if (!matched && rule.key.toLowerCase() === 'set-cookie') {
        for (const [hk, hv2] of Object.entries(headers)) {
          if (hk.includes('cookie') && rule.pattern.test(hv2)) {
            matched = true
            value = hv2
            break
          }
        }
      }
    } else if (rule.kind === 'cookie' && rule.key) {
      const cookie = headers['set-cookie'] ?? headers.cookie ?? ''
      if (
        cookie.toLowerCase().includes(rule.key.toLowerCase()) &&
        rule.pattern.test(cookie)
      ) {
        matched = true
        value = rule.key
      }
    } else if (rule.kind === 'body') {
      const m = body.match(rule.pattern)
      if (m) {
        matched = true
        value = m[0]!.slice(0, 80)
      }
    } else if (rule.kind === 'path') {
      if (rule.pattern.test(url)) {
        matched = true
        value = url
      }
    } else if (rule.kind === 'title' && title) {
      if (rule.pattern.test(title)) {
        matched = true
        value = title
      }
    }
    if (matched) {
      signals.push({
        kind: rule.kind,
        key: rule.key ?? rule.kind,
        value,
        product: rule.product,
        confidence: rule.confidence,
      })
      pushUnique(products, rule.product)
    }
  }

  // Title as a soft signal
  if (title) {
    for (const product of [
      'Jenkins',
      'GitLab',
      'Grafana',
      'Confluence',
      'Jira',
      'vCenter',
      'Nacos',
      'RabbitMQ',
    ]) {
      if (title.toLowerCase().includes(product.toLowerCase())) {
        signals.push({
          kind: 'title',
          key: 'title',
          value: title,
          product:
            product === 'Confluence'
              ? 'Atlassian Confluence'
              : product === 'Jira'
                ? 'Atlassian Jira'
                : product === 'vCenter'
                  ? 'VMware vCenter'
                  : product,
          confidence: 0.7,
        })
        pushUnique(
          products,
          product === 'Confluence'
            ? 'Atlassian Confluence'
            : product === 'Jira'
              ? 'Atlassian Jira'
              : product === 'vCenter'
                ? 'VMware vCenter'
                : product,
        )
      }
    }
  }

  return {
    url,
    products,
    signals,
    rawHeaders: headers,
    statusCode: input.statusCode,
    title,
    server: headers.server,
  }
}

/**
 * Score how well a catalog product string matches a fingerprint product.
 * Pure helper used by nday capture.
 */
export function productMatchScore(catalogProduct: string, fpProduct: string): number {
  const a = catalogProduct.toLowerCase()
  const b = fpProduct.toLowerCase()
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return 0.85
  const at = new Set(a.split(/[^a-z0-9]+/).filter(Boolean))
  const bt = b.split(/[^a-z0-9]+/).filter(Boolean)
  let hit = 0
  for (const t of bt) if (at.has(t)) hit += 1
  if (bt.length === 0) return 0
  const ratio = hit / bt.length
  return ratio >= 0.5 ? ratio * 0.7 : 0
}
