/**
 * Generate / expand the workspace PoC *reference* catalog.
 *
 *   bun run scripts/gen-poc-catalog.ts
 *
 * Writes ~100 scope-gated public CVE / advisory references to
 * `redscope-poc-catalog.json`. This is metadata + official links only —
 * no exploit code, no payloads, no live-target execution.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Severity = 'critical' | 'high' | 'medium' | 'low'

type Entry = {
  id: string
  title: string
  product: string
  category: string
  severity: Severity
  cvss: number
  references: string[]
  requiresAuthorizedScope: true
  addedAt: string
}

const TODAY = '2026-07-27'

function nvd(cve: string): string {
  return `https://nvd.nist.gov/vuln/detail/${cve}`
}

function entry(
  id: string,
  title: string,
  product: string,
  category: string,
  severity: Severity,
  cvss: number,
  extraRefs: string[] = [],
): Entry {
  return {
    id,
    title,
    product,
    category,
    severity,
    cvss,
    references: [nvd(id), ...extraRefs],
    requiresAuthorizedScope: true,
    addedAt: TODAY,
  }
}

const RAW: Entry[] = [
  entry('CVE-2021-44228', 'Apache Log4j2 JNDI lookup remote code execution (Log4Shell)', 'Apache Log4j 2.x', 'rce', 'critical', 10.0, ['https://logging.apache.org/log4j/2.x/security.html']),
  entry('CVE-2022-22965', 'Spring Framework data binding remote code execution (Spring4Shell)', 'Spring Framework', 'rce', 'critical', 9.8, ['https://spring.io/security/cve-2022-22965']),
  entry('CVE-2017-5638', 'Apache Struts 2 Jakarta Multipart parser remote code execution', 'Apache Struts 2', 'rce', 'critical', 10.0, ['https://cwiki.apache.org/confluence/display/WW/S2-045']),
  entry('CVE-2019-0708', 'Microsoft RDP pre-auth remote code execution (BlueKeep)', 'Microsoft Windows Remote Desktop Services', 'rce', 'critical', 9.8, ['https://msrc.microsoft.com/update-guide/vulnerability/CVE-2019-0708']),
  entry('CVE-2017-0144', 'Microsoft SMBv1 remote code execution (EternalBlue)', 'Microsoft Windows SMBv1', 'rce', 'high', 8.1, ['https://learn.microsoft.com/security-updates/securitybulletins/2017/ms17-010']),
  entry('CVE-2020-1472', 'Netlogon elevation of privilege (Zerologon)', 'Microsoft Windows Netlogon', 'privilege-escalation', 'critical', 10.0, ['https://msrc.microsoft.com/update-guide/vulnerability/CVE-2020-1472']),
  entry('CVE-2021-26855', 'Microsoft Exchange Server SSRF (ProxyLogon)', 'Microsoft Exchange Server', 'ssrf', 'critical', 9.8, ['https://msrc.microsoft.com/update-guide/vulnerability/CVE-2021-26855']),
  entry('CVE-2014-0160', 'OpenSSL TLS heartbeat information disclosure (Heartbleed)', 'OpenSSL', 'info-disclosure', 'high', 7.5, ['https://www.openssl.org/news/secadv/20140407.txt']),
  entry('CVE-2019-19781', 'Citrix ADC / Gateway directory traversal to code execution', 'Citrix ADC / NetScaler Gateway', 'path-traversal', 'critical', 9.8, ['https://support.citrix.com/article/CTX267027']),
  entry('CVE-2018-13379', 'Fortinet FortiOS SSL VPN path traversal credential disclosure', 'Fortinet FortiOS SSL VPN', 'path-traversal', 'high', 9.8, ['https://www.fortiguard.com/psirt/FG-IR-18-384']),
  entry('CVE-2022-1388', 'F5 BIG-IP iControl REST authentication bypass', 'F5 BIG-IP', 'auth-bypass', 'critical', 9.8, ['https://my.f5.com/manage/s/article/K23605346']),
  entry('CVE-2023-34362', 'Progress MOVEit Transfer SQL injection', 'Progress MOVEit Transfer', 'sqli', 'critical', 9.8, ['https://community.progress.com/s/article/MOVEit-Transfer-Critical-Vulnerability-31May2023']),
  entry('CVE-2021-34527', 'Windows Print Spooler remote code execution (PrintNightmare)', 'Microsoft Windows Print Spooler', 'rce', 'critical', 8.8, ['https://msrc.microsoft.com/update-guide/vulnerability/CVE-2021-34527']),
  entry('CVE-2021-36942', 'Windows LSA spoofing vulnerability (PetitPotam related)', 'Microsoft Windows LSA', 'spoofing', 'high', 7.5),
  entry('CVE-2019-0604', 'Microsoft SharePoint remote code execution', 'Microsoft SharePoint', 'rce', 'critical', 9.8),
  entry('CVE-2020-0688', 'Microsoft Exchange validation key remote code execution', 'Microsoft Exchange Server', 'rce', 'high', 8.8),
  entry('CVE-2021-34473', 'Microsoft Exchange Server privilege escalation (ProxyShell chain)', 'Microsoft Exchange Server', 'privilege-escalation', 'critical', 9.8),
  entry('CVE-2021-31207', 'Microsoft Exchange Server security feature bypass (ProxyShell chain)', 'Microsoft Exchange Server', 'security-bypass', 'high', 7.2),
  entry('CVE-2021-34523', 'Microsoft Exchange Server elevation of privilege (ProxyShell chain)', 'Microsoft Exchange Server', 'privilege-escalation', 'high', 9.0),
  entry('CVE-2022-41040', 'Microsoft Exchange Server SSRF (ProxyNotShell)', 'Microsoft Exchange Server', 'ssrf', 'high', 8.8),
  entry('CVE-2022-41082', 'Microsoft Exchange Server remote code execution (ProxyNotShell)', 'Microsoft Exchange Server', 'rce', 'high', 8.8),
  entry('CVE-2023-23397', 'Microsoft Outlook elevation of privilege (NTLM hash leak)', 'Microsoft Outlook', 'privilege-escalation', 'critical', 9.8),
  entry('CVE-2021-40444', 'Microsoft MSHTML remote code execution', 'Microsoft Windows MSHTML', 'rce', 'high', 8.8),
  entry('CVE-2017-0199', 'Microsoft Office / WordPad remote code execution', 'Microsoft Office', 'rce', 'high', 7.8),
  entry('CVE-2017-11882', 'Microsoft Office Equation Editor remote code execution', 'Microsoft Office', 'rce', 'high', 7.8),
  entry('CVE-2020-0796', 'Windows SMBv3 compression remote code execution (SMBGhost)', 'Microsoft Windows SMBv3', 'rce', 'critical', 10.0),
  entry('CVE-2021-1675', 'Windows Print Spooler remote code execution', 'Microsoft Windows Print Spooler', 'rce', 'high', 8.8),
  entry('CVE-2022-26923', 'Active Directory Domain Services privilege escalation (Certifried)', 'Microsoft Active Directory', 'privilege-escalation', 'high', 8.8),
  entry('CVE-2021-42278', 'Active Directory sAMAccountName spoofing (noPac chain)', 'Microsoft Active Directory', 'privilege-escalation', 'high', 8.8),
  entry('CVE-2021-42287', 'Active Directory Privilege Escalation (noPac chain)', 'Microsoft Active Directory', 'privilege-escalation', 'high', 8.8),
  entry('CVE-2019-1040', 'Windows NTLM MIC bypass (relay enablement)', 'Microsoft Windows NTLM', 'auth-bypass', 'high', 7.5),
  entry('CVE-2019-1166', 'Windows NTLM tampering vulnerability', 'Microsoft Windows NTLM', 'auth-bypass', 'high', 7.5),
  entry('CVE-2022-21907', 'HTTP Protocol Stack remote code execution (http.sys)', 'Microsoft Windows HTTP.sys', 'rce', 'critical', 9.8),
  entry('CVE-2021-31166', 'HTTP Protocol Stack remote code execution', 'Microsoft Windows HTTP.sys', 'rce', 'critical', 9.8),
  entry('CVE-2020-1350', 'Windows DNS Server remote code execution (SIGRed)', 'Microsoft Windows DNS Server', 'rce', 'critical', 10.0),
  entry('CVE-2018-7600', 'Drupal core remote code execution (Drupalgeddon2)', 'Drupal', 'rce', 'critical', 9.8),
  entry('CVE-2018-7602', 'Drupal core remote code execution (Drupalgeddon2 follow-on)', 'Drupal', 'rce', 'critical', 9.8),
  entry('CVE-2019-6340', 'Drupal core remote code execution (REST / HAL)', 'Drupal', 'rce', 'high', 8.1),
  entry('CVE-2017-9841', 'PHPUnit eval-stdin.php remote code execution', 'PHPUnit', 'rce', 'critical', 9.8),
  entry('CVE-2012-1823', 'PHP-CGI argument injection remote code execution', 'PHP CGI', 'rce', 'high', 7.5),
  entry('CVE-2019-9193', 'PostgreSQL COPY PROGRAM remote code execution (superuser)', 'PostgreSQL', 'rce', 'high', 7.2),
  entry('CVE-2016-6662', 'MySQL remote code execution / privilege escalation', 'MySQL / MariaDB', 'rce', 'high', 9.0),
  entry('CVE-2012-2122', 'MySQL authentication bypass via memcmp', 'MySQL', 'auth-bypass', 'high', 7.5),
  entry('CVE-2021-22205', 'GitLab ExifTool remote code execution', 'GitLab / ExifTool', 'rce', 'critical', 10.0),
  entry('CVE-2021-3129', 'Laravel Ignition remote code execution', 'Laravel Ignition', 'rce', 'critical', 9.8),
  entry('CVE-2018-15133', 'Laravel unserialize remote code execution', 'Laravel', 'rce', 'high', 8.1),
  entry('CVE-2019-11043', 'PHP-FPM remote code execution (env underflow)', 'PHP-FPM / nginx', 'rce', 'critical', 9.8),
  entry('CVE-2017-12615', 'Apache Tomcat PUT JSP remote code execution', 'Apache Tomcat', 'rce', 'high', 8.1),
  entry('CVE-2020-1938', 'Apache Tomcat AJP Ghostcat file read / inclusion', 'Apache Tomcat', 'file-read', 'critical', 9.8),
  entry('CVE-2019-0232', 'Apache Tomcat Remote OpenCGI privilege / RCE (Windows)', 'Apache Tomcat', 'rce', 'high', 8.1),
  entry('CVE-2016-3088', 'Apache ActiveMQ Fileserver arbitrary file write', 'Apache ActiveMQ', 'rce', 'critical', 9.8),
  entry('CVE-2023-46604', 'Apache ActiveMQ OpenWire remote code execution', 'Apache ActiveMQ', 'rce', 'critical', 10.0),
  entry('CVE-2017-12635', 'Apache CouchDB privilege escalation via dual roles', 'Apache CouchDB', 'privilege-escalation', 'critical', 9.8),
  entry('CVE-2017-12636', 'Apache CouchDB remote code execution via query servers', 'Apache CouchDB', 'rce', 'critical', 9.8),
  entry('CVE-2019-11510', 'Pulse Secure VPN arbitrary file read', 'Pulse Secure VPN', 'file-read', 'critical', 10.0),
  entry('CVE-2019-11539', 'Pulse Secure VPN post-auth command injection', 'Pulse Secure VPN', 'rce', 'high', 8.8),
  entry('CVE-2021-22893', 'Pulse Secure VPN authentication bypass', 'Pulse Secure VPN', 'auth-bypass', 'critical', 10.0),
  entry('CVE-2020-5902', 'F5 BIG-IP TMUI remote code execution', 'F5 BIG-IP', 'rce', 'critical', 9.8),
  entry('CVE-2021-22986', 'F5 BIG-IP iControl REST remote code execution', 'F5 BIG-IP', 'rce', 'critical', 9.8),
  entry('CVE-2020-3452', 'Cisco ASA / FTD path traversal read', 'Cisco ASA / FTD', 'path-traversal', 'high', 7.5),
  entry('CVE-2018-0296', 'Cisco ASA path traversal / DoS', 'Cisco ASA', 'path-traversal', 'high', 7.5),
  entry('CVE-2020-3187', 'Cisco ASA / FTD path traversal', 'Cisco ASA / FTD', 'path-traversal', 'high', 7.5),
  entry('CVE-2019-2725', 'Oracle WebLogic wls9_async deserialization RCE', 'Oracle WebLogic', 'rce', 'critical', 9.8),
  entry('CVE-2017-10271', 'Oracle WebLogic WLS-WSAT deserialization RCE', 'Oracle WebLogic', 'rce', 'critical', 7.5),
  entry('CVE-2020-14882', 'Oracle WebLogic Console remote code execution', 'Oracle WebLogic', 'rce', 'critical', 9.8),
  entry('CVE-2020-14883', 'Oracle WebLogic Console authenticated RCE', 'Oracle WebLogic', 'rce', 'high', 7.2),
  entry('CVE-2019-3396', 'Atlassian Confluence Server path traversal / RCE', 'Atlassian Confluence', 'rce', 'critical', 9.8),
  entry('CVE-2021-26084', 'Atlassian Confluence OGNL injection RCE', 'Atlassian Confluence', 'rce', 'critical', 9.8),
  entry('CVE-2022-26134', 'Atlassian Confluence OGNL injection unauth RCE', 'Atlassian Confluence', 'rce', 'critical', 9.8),
  entry('CVE-2019-11580', 'Atlassian Crowd remote code execution', 'Atlassian Crowd', 'rce', 'critical', 9.8),
  entry('CVE-2022-0543', 'Redis Lua sandbox escape remote code execution', 'Redis', 'rce', 'critical', 10.0),
  entry('CVE-2015-4335', 'Redis EVAL Lua sandbox escape', 'Redis', 'rce', 'high', 9.0),
  entry('CVE-2021-45046', 'Apache Log4j2 thread-context DoS / partial RCE follow-on', 'Apache Log4j 2.x', 'rce', 'critical', 9.0),
  entry('CVE-2021-45105', 'Apache Log4j2 unbounded recursion DoS', 'Apache Log4j 2.x', 'dos', 'medium', 5.9),
  entry('CVE-2022-42889', 'Apache Commons Text StringLookup interpolation RCE (Text4Shell)', 'Apache Commons Text', 'rce', 'critical', 9.8),
  entry('CVE-2021-41773', 'Apache HTTP Server path traversal', 'Apache HTTP Server 2.4.49', 'path-traversal', 'high', 7.5),
  entry('CVE-2021-42013', 'Apache HTTP Server path traversal / RCE follow-on', 'Apache HTTP Server 2.4.50', 'rce', 'critical', 9.8),
  entry('CVE-2017-15715', 'Apache HTTP Server FilesMatch upload bypass', 'Apache HTTP Server', 'security-bypass', 'high', 7.5),
  entry('CVE-2019-0211', 'Apache HTTP Server privilege escalation (MPM scoreboard)', 'Apache HTTP Server', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2014-6271', 'GNU Bash environment variable remote code execution (Shellshock)', 'GNU Bash', 'rce', 'critical', 9.8),
  entry('CVE-2014-7169', 'GNU Bash incomplete fix follow-on (Shellshock)', 'GNU Bash', 'rce', 'critical', 9.8),
  entry('CVE-2016-5195', 'Linux kernel dirty COW privilege escalation', 'Linux kernel', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2021-4034', 'Polkit pkexec privilege escalation (PwnKit)', 'polkit', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2021-3156', 'Sudo heap-based buffer overflow (Baron Samedit)', 'sudo', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2019-14287', 'Sudo security policy bypass via runas ID', 'sudo', 'privilege-escalation', 'high', 8.8),
  entry('CVE-2022-0847', 'Linux kernel Dirty Pipe privilege escalation', 'Linux kernel', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2023-0386', 'Linux kernel OverlayFS privilege escalation', 'Linux kernel', 'privilege-escalation', 'high', 7.8),
  entry('CVE-2019-5736', 'runc container breakout via /proc/self/exe', 'runc', 'container-escape', 'high', 8.6),
  entry('CVE-2022-0492', 'Linux cgroups v1 container escape', 'Linux kernel cgroups', 'container-escape', 'high', 7.8),
  entry('CVE-2020-15257', 'containerd-shim abstract unix socket access', 'containerd', 'container-escape', 'medium', 5.2),
  entry('CVE-2018-1002105', 'Kubernetes API server privilege escalation', 'Kubernetes', 'privilege-escalation', 'critical', 9.8),
  entry('CVE-2020-8554', 'Kubernetes Man-in-the-Middle via LoadBalancer / ExternalIP', 'Kubernetes', 'mitm', 'medium', 6.0),
  entry('CVE-2021-25742', 'Ingress-nginx arbitrary file read via snippet', 'ingress-nginx', 'file-read', 'high', 7.6),
  entry('CVE-2019-11247', 'Kubernetes API server namespace isolation bypass', 'Kubernetes', 'auth-bypass', 'high', 8.2),
  entry('CVE-2022-31626', 'PHP sqlite3/pdo_sqlite buffer overflow', 'PHP', 'rce', 'high', 8.8),
  entry('CVE-2024-21762', 'Fortinet FortiOS out-of-bound write RCE', 'Fortinet FortiOS', 'rce', 'critical', 9.8),
  entry('CVE-2024-3400', 'Palo Alto PAN-OS GlobalProtect command injection', 'Palo Alto PAN-OS', 'rce', 'critical', 10.0),
  entry('CVE-2023-27997', 'Fortinet FortiOS / FortiProxy heap overflow RCE', 'Fortinet FortiOS', 'rce', 'critical', 9.8),
  entry('CVE-2023-20198', 'Cisco IOS XE Web UI privilege escalation', 'Cisco IOS XE', 'privilege-escalation', 'critical', 10.0),
  entry('CVE-2023-20273', 'Cisco IOS XE Web UI command injection', 'Cisco IOS XE', 'rce', 'high', 7.2),
  entry('CVE-2023-4966', 'Citrix NetScaler information disclosure (Bleed)', 'Citrix NetScaler ADC / Gateway', 'info-disclosure', 'critical', 9.4),
  entry('CVE-2023-3519', 'Citrix NetScaler ADC / Gateway code injection', 'Citrix NetScaler ADC / Gateway', 'rce', 'critical', 9.8),
  entry('CVE-2022-42475', 'Fortinet FortiOS SSL-VPN heap overflow RCE', 'Fortinet FortiOS', 'rce', 'critical', 9.8),
  entry('CVE-2021-21972', 'VMware vCenter Server remote code execution', 'VMware vCenter', 'rce', 'critical', 9.8),
  entry('CVE-2021-22005', 'VMware vCenter Server arbitrary file upload', 'VMware vCenter', 'rce', 'critical', 9.8),
  entry('CVE-2021-21985', 'VMware vSphere Client remote code execution', 'VMware vSphere Client', 'rce', 'critical', 9.8),
  entry('CVE-2022-22954', 'VMware Workspace ONE Access server-side template injection', 'VMware Workspace ONE Access', 'rce', 'critical', 9.8),
  entry('CVE-2022-22972', 'VMware Workspace ONE Access authentication bypass', 'VMware Workspace ONE Access', 'auth-bypass', 'critical', 9.8),
  entry('CVE-2023-20887', 'VMware Aria Operations for Networks command injection', 'VMware Aria Operations', 'rce', 'critical', 9.8),
  entry('CVE-2022-40684', 'Fortinet FortiOS authentication bypass', 'Fortinet FortiOS / FortiProxy', 'auth-bypass', 'critical', 9.8),
  entry('CVE-2023-46747', 'F5 BIG-IP configuration utility authentication bypass', 'F5 BIG-IP', 'auth-bypass', 'critical', 9.8),
  entry('CVE-2023-46748', 'F5 BIG-IP configuration utility command injection', 'F5 BIG-IP', 'rce', 'high', 8.8),
  entry('CVE-2023-22515', 'Atlassian Confluence broken access control privilege escalation', 'Atlassian Confluence', 'privilege-escalation', 'critical', 10.0),
  entry('CVE-2023-22518', 'Atlassian Confluence improper authorization', 'Atlassian Confluence', 'auth-bypass', 'critical', 9.1),
  entry('CVE-2022-36804', 'Atlassian Bitbucket command injection', 'Atlassian Bitbucket', 'rce', 'high', 8.8),
  entry('CVE-2019-5418', 'Rails Action View file content disclosure', 'Ruby on Rails', 'file-read', 'high', 7.5),
  entry('CVE-2020-6287', 'SAP NetWeaver AS Java authentication bypass (RECON)', 'SAP NetWeaver', 'auth-bypass', 'critical', 10.0),
  entry('CVE-2017-9805', 'Apache Struts 2 REST plugin XStream RCE', 'Apache Struts 2', 'rce', 'high', 8.1),
  entry('CVE-2018-11776', 'Apache Struts 2 namespace remote code execution', 'Apache Struts 2', 'rce', 'high', 8.1),
  entry('CVE-2016-4437', 'Apache Shiro rememberMe deserialization RCE', 'Apache Shiro', 'rce', 'high', 8.1),
  entry('CVE-2020-1957', 'Apache Shiro authentication bypass', 'Apache Shiro', 'auth-bypass', 'high', 8.1),
  entry('CVE-2019-0230', 'Apache Struts 2 OGNL double evaluation RCE', 'Apache Struts 2', 'rce', 'critical', 9.8),
  entry('CVE-2020-17530', 'Apache Struts 2 forced OGNL evaluation RCE', 'Apache Struts 2', 'rce', 'critical', 9.8),
  entry('CVE-2021-26086', 'Atlassian Jira limited file read', 'Atlassian Jira', 'file-read', 'medium', 5.3),
  entry('CVE-2019-3398', 'Atlassian Confluence download resource path traversal', 'Atlassian Confluence', 'path-traversal', 'high', 8.8),
  entry('CVE-2020-14179', 'Atlassian Jira information disclosure', 'Atlassian Jira', 'info-disclosure', 'medium', 5.3),
  entry('CVE-2022-22963', 'Spring Cloud Function SpEL remote code execution', 'Spring Cloud Function', 'rce', 'critical', 9.8),
  entry('CVE-2022-22947', 'Spring Cloud Gateway Actuator SpEL code injection', 'Spring Cloud Gateway', 'rce', 'critical', 10.0),
]

function normalizeEntries(raw: Entry[]): Entry[] {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const e of raw) {
    if (!/^CVE-\d{4}-\d{4,}$/i.test(e.id)) continue
    const id = e.id.toUpperCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      ...e,
      id,
      references: [nvd(id), ...e.references.filter(r => !r.includes(e.id) || r.includes('nvd.nist.gov') === false)].filter(
        (r, i, arr) => arr.indexOf(r) === i,
      ),
    })
  }
  return out
}

const entries = normalizeEntries(RAW)

const catalog = {
  schemaVersion: 1,
  generatedAt: TODAY,
  _about: [
    'Reference index of publicly-disclosed vulnerabilities for authorized red-team planning.',
    'This file contains metadata and links to official advisories ONLY — no exploit code or payloads.',
    'Every entry is scope-gated: use is permitted only against targets inside a written, authorized engagement scope.',
    'Populate / refresh with: bun run scripts/gen-poc-catalog.ts',
    'RedScope does not auto-run any entry against a live target.',
  ],
  entries,
}

const outPath = resolve(process.cwd(), 'redscope-poc-catalog.json')
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8')
console.log(
  `[gen-poc-catalog] wrote ${outPath} (${entries.length} scope-gated references)`,
)
