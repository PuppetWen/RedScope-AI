export const REDSCOPE_GUIDE_AGENT_TYPE = 'redscope-guide'
const legacyGuideType = 'claude-code-guide'

type NamedAgent = { agentType: string; source: string }

/** An explicitly configured role keeps its name, including the previous built-in name. */
export function findAgentByType<T extends NamedAgent>(
  agents: readonly T[],
  requested: string | undefined,
): T | undefined {
  if (requested === undefined) return undefined
  const exact = agents.find(agent => agent.agentType === requested)
  if (exact || requested !== legacyGuideType) return exact
  return agents.find(
    agent => agent.source === 'built-in' && agent.agentType === REDSCOPE_GUIDE_AGENT_TYPE,
  )
}

/** Resolve role allowlists before filtering so a denied custom namesake cannot reveal the alias. */
export function resolveAllowedAgentTypes(
  agents: readonly NamedAgent[],
  allowedNames: string[] | undefined,
): string[] | undefined {
  return allowedNames?.map(name => findAgentByType(agents, name)?.agentType ?? name)
}

/** Old deny rules continue to cover the renamed product guide. */
export function canonicalAgentPolicyName(name: string): string {
  return name === legacyGuideType ? REDSCOPE_GUIDE_AGENT_TYPE : name
}
