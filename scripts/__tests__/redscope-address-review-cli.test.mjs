import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(root, 'dist/cli-node.js')

test('built address-review CLI sends only summary data to the selected model', async t => {
  const dir = await mkdtemp(join(root, '.address-cli-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url })
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.at(-1).body = JSON.parse(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({
      choices: [{ index: 0, delta: { content: '样例页面说明' }, finish_reason: 'stop' }],
    }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = 'http://127.0.0.1:' + server.address().port
  const target = origin + '/help?session=QUERY_CANARY#FRAGMENT_CANARY'
  const notes = join(dir, 'notes.txt')
  await writeFile(notes, '使用手册')
  const config = join(dir, 'config')
  await mkdir(config)
  await writeFile(join(config, 'env.config'), [
    'REDSCOPE_MODEL_PROVIDER=openai',
    'REDSCOPE_API_KEY=local-placeholder',
    'REDSCOPE_BASE_URL=' + origin + '/v1',
    'REDSCOPE_MODEL=model-default',
  ].join('\n'))
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    TEMP: dir, TMP: dir, TMPDIR: dir, XDG_CONFIG_HOME: dir,
    REDSCOPE_CONFIG_DIR: config, CLAUDE_CONFIG_DIR: join(dir, 'legacy'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CI: '1',
  }
  const node = process.versions.bun ? 'node' : process.execPath
  for (const [args, model, excerpt] of [
    [[target], 'model-default', ''],
    [['address-review', target, '--model', 'model-selected', '--notes', notes], 'model-selected', '使用手册'],
  ]) {
    const { stdout } = await exec(node, [cli, ...args], { cwd: dir, env, timeout: 15000 })
    assert.match(stdout, /样例页面说明/)
    const body = requests.at(-1)?.body
    assert.equal(body?.model, model)
    assert.equal(body.tools?.length ?? 0, 0)
    assert.doesNotMatch(JSON.stringify(body), /QUERY_CANARY|FRAGMENT_CANARY/)
    const material = JSON.parse(body.messages.find(msg => msg.role === 'user').content)
    assert.equal(material.address, origin + '/help')
    assert.equal(material.excerpt, excerpt)
  }
  assert.deepEqual(requests.map(req => req.url), ['/v1/chat/completions', '/v1/chat/completions'])
})
