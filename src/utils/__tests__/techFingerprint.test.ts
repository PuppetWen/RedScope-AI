import { describe, expect, test } from 'bun:test'
import {
  fingerprintHttpResponse,
  productMatchScore,
} from '../techFingerprint'

describe('fingerprintHttpResponse', () => {
  test('detects Exchange from path + body', () => {
    const fp = fingerprintHttpResponse({
      url: 'https://mail.example/owa/',
      statusCode: 200,
      headers: { server: 'Microsoft-IIS/10.0' },
      body: '<html>OutlookWebApp login</html>',
    })
    expect(fp.products).toContain('Microsoft Exchange Server')
    expect(fp.products).toContain('Microsoft IIS')
  })

  test('detects GitLab from title and body', () => {
    const fp = fingerprintHttpResponse({
      url: 'https://git.example/',
      body: '<title>GitLab</title><script>gon.gitlab=true</script>',
    })
    expect(fp.products.some(p => /GitLab/i.test(p))).toBe(true)
  })

  test('detects Shiro rememberMe cookie', () => {
    const fp = fingerprintHttpResponse({
      headers: { 'set-cookie': 'rememberMe=deleteMe; Path=/' },
      body: '',
    })
    expect(fp.products).toContain('Shiro')
  })

  test('detects Fortinet SSL VPN markers', () => {
    const fp = fingerprintHttpResponse({
      body: '<html>FortiGate sslvpn fgtauth</html>',
    })
    expect(
      fp.products.some(p => /Fortinet/i.test(p)),
    ).toBe(true)
  })
})

describe('productMatchScore', () => {
  test('scores exact and partial product matches', () => {
    expect(productMatchScore('Apache HTTP Server', 'Apache HTTP Server')).toBe(1)
    expect(
      productMatchScore('Microsoft Exchange Server', 'Exchange'),
    ).toBeGreaterThan(0.5)
    expect(productMatchScore('nginx', 'Redis')).toBe(0)
  })
})
