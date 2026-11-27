import { describe, expect, test } from 'bun:test'
import { getBuiltInAgents } from '../builtInAgents.js'
import { findAgentByType, resolveAllowedAgentTypes } from '../agentTypeNames.js'
import { REDSCOPE_GUIDE_AGENT as guide } from '../built-in/redscopeGuideAgent.js'

describe('RedScope product guide', () => {
  test('lists the guide in both CLI entrypoints while preserving the SDK role set', () => {
    const original = process.env.CLAUDE_CODE_ENTRYPOINT
    try {
      for (const entry of ['cli', 'sdk-cli', 'sdk-ts', 'sdk-py']) {
        process.env.CLAUDE_CODE_ENTRYPOINT = entry
        const names = getBuiltInAgents().map(agent => agent.agentType)
        expect(names.includes('redscope-guide')).toBe(entry === 'cli' || entry === 'sdk-cli')
        expect(names).not.toContain('claude-code-guide')
      }
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = original
    }
  })

  test('answers from product documentation and passes names without configuration values', () => {
    const prompt = guide.getSystemPrompt({
      toolUseContext: {
        options: {
          commands: [{ name: 'help', description: 'sensitive-test-description' }],
          agentDefinitions: { activeAgents: [guide] },
          mcpClients: [{ name: 'example', headers: { authorization: 'sensitive-test-header' } }],
        },
      },
    } as unknown as Parameters<typeof guide.getSystemPrompt>[0])

    expect(guide.agentType).toBe('redscope-guide')
    expect(prompt).toContain('README.md')
    expect(prompt).toContain('docs/usage.md')
    expect(prompt).toContain('env.config.example')
    expect(prompt).toContain('https://github.com/PuppetWen/RedScope-AI')
    expect(prompt).toContain('"mcpServers":["example"]')
    expect(prompt).not.toContain('sensitive-test-')
    expect(prompt).not.toContain('code.claude.com')
    expect(guide.tools).not.toContain('Write')
    expect(guide.tools).not.toContain('Bash')
  })

  test('restores old explicit selections without introducing a second registered agent', () => {
    const agents = [guide]
    expect(findAgentByType(agents, 'claude-code-guide')).toBe(guide)
    expect(findAgentByType(agents, 'redscope-guide')).toBe(guide)
    expect(findAgentByType([], 'claude-code-guide')).toBeUndefined()
    expect(resolveAllowedAgentTypes(agents, ['claude-code-guide'])).toEqual(['redscope-guide'])
  })

  test('custom names keep their meanings when resolving old requests and allowlists', () => {
    const custom = { agentType: 'claude-code-guide', source: 'projectSettings' }
    const replacement = { agentType: 'redscope-guide', source: 'projectSettings' }
    expect(findAgentByType([guide, custom], 'claude-code-guide')).toBe(custom)
    expect(resolveAllowedAgentTypes([guide, custom], ['claude-code-guide'])).toEqual(['claude-code-guide'])
    expect(findAgentByType([replacement], 'claude-code-guide')).toBeUndefined()
  })
})
