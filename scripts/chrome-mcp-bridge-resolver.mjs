import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REDSCOPE_BRIDGE_PACKAGE = "@redscope-ai/mcp-chrome-bridge";
const BRIDGE_CLI_SUBPATH = "dist/cli.js";

export function getLocalRedScopeBridgeCliPath(baseUrl = import.meta.url) {
  return fileURLToPath(
    new URL("../packages/mcp-chrome-bridge/dist/cli.js", baseUrl),
  );
}

export function resolveChromeMcpBridgeCliPath({
  baseUrl = import.meta.url,
  exists = existsSync,
  requireFn = createRequire(import.meta.url),
} = {}) {
  const localRedScopeCliPath = getLocalRedScopeBridgeCliPath(baseUrl);
  if (exists(localRedScopeCliPath)) {
    return {
      cliPath: localRedScopeCliPath,
      packageName: REDSCOPE_BRIDGE_PACKAGE,
      source: "workspace",
    };
  }

  try {
    return {
      cliPath: requireFn.resolve(
        `${REDSCOPE_BRIDGE_PACKAGE}/${BRIDGE_CLI_SUBPATH}`,
      ),
      packageName: REDSCOPE_BRIDGE_PACKAGE,
      source: "package",
    };
  } catch {
    // Fall through to the RedScope-scoped install error below.
  }

  throw new Error(
    `Unable to locate Chrome MCP bridge CLI. Install ${REDSCOPE_BRIDGE_PACKAGE}.`,
  );
}
