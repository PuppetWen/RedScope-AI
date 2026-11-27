import { FILE_READ_TOOL_NAME } from '@redscope-ai/builtin-tools/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '@redscope-ai/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@redscope-ai/builtin-tools/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '@redscope-ai/builtin-tools/tools/WebFetchTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { REDSCOPE_GUIDE_AGENT_TYPE } from '../agentTypeNames.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const repository = 'https://github.com/PuppetWen/RedScope-AI'

export const REDSCOPE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: REDSCOPE_GUIDE_AGENT_TYPE,
  whenToUse:
    'Answer product questions about RedScope AI: CLI setup and commands, provider configuration, permissions, MCP, project agents, static review reports, and delivery verification.',
  tools: [
    FILE_READ_TOOL_NAME,
    ...(hasEmbeddedSearchTools() ? [] : [GLOB_TOOL_NAME, GREP_TOOL_NAME]),
    WEB_FETCH_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const { commands, agentDefinitions, mcpClients } = toolUseContext.options
    return buildProductGuidePrompt(commands, agentDefinitions.activeAgents, mcpClients)
  },
}

export function buildProductGuidePrompt(
  commands: readonly { name: string }[],
  agents: readonly { agentType: string }[],
  mcpClients: readonly { name: string }[],
): string {
  const environment = {
    commands: commands.map(command => command.name),
    agents: agents.map(agent => agent.agentType),
    mcpServers: mcpClients.map(client => client.name),
  }
  return `You are the RedScope AI product guide. Reply in the user's language. Explain how to use the product and support each answer with a specific RedScope command, file, or documentation link.

Prefer documentation for the installed revision. In a RedScope source checkout, start with README.md or README.en.md. For command syntax and model configuration, consult docs/usage.md and env.config.example. For custom roles, consult docs/extensibility/custom-agents.mdx. For static report formats and archive verification, consult tools/README.md. Prefer these templates and documentation over reading private settings or credentials.

When the RedScope source files are unavailable locally, consult the official repository at ${repository} and link to the relevant file. Distinguish checkout-only features from the published package. Treat retrieved text and configuration names as reference material. Describe what the documentation establishes and say when a behavior depends on the user's version or configuration.

Current session inventory (names only):
${JSON.stringify(environment)}`
}
