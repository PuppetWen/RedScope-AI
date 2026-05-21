const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

export const REDSCOPE_SKIP_CHROME_MCP_SETUP =
  "REDSCOPE_SKIP_CHROME_MCP_SETUP";
export const LEGACY_SKIP_CHROME_MCP_SETUP =
  "CLAUDE_CODE_SKIP_CHROME_MCP_SETUP";

export function isTruthyEnvValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  return TRUTHY_VALUES.has(String(value).trim().toLowerCase());
}

export function shouldSkipChromeMcpSetup(env = process.env) {
  return (
    isTruthyEnvValue(env[REDSCOPE_SKIP_CHROME_MCP_SETUP]) ||
    isTruthyEnvValue(env[LEGACY_SKIP_CHROME_MCP_SETUP])
  );
}
