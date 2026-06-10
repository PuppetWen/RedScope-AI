#!/usr/bin/env node

console.error(
  [
    'The RedScope Chrome MCP stdio workspace shim does not include the full MCP server runtime yet.',
    'Use `redscope --claude-in-chrome-mcp` from the main package, or replace this shim with the real bridge dist artifacts.',
  ].join('\n'),
)
process.exit(1)
