#!/usr/bin/env node

const command = process.argv[2] ?? 'help'

function printHelp() {
  console.log(`RedScope Chrome MCP bridge workspace shim

Usage:
  mcp-chrome-bridge fix-permissions
  mcp-chrome-bridge register --browser chrome
  mcp-chrome-bridge doctor

This shim keeps the RedScope workspace package executable during development.
The full Chrome bridge runtime should be provided by this package's real dist
artifacts before publishing.`)
}

switch (command) {
  case 'fix-permissions':
    process.exit(0)
    break
  case 'register':
    process.exit(0)
    break
  case 'doctor':
    console.log('Chrome MCP bridge workspace shim is available.')
    process.exit(0)
    break
  case 'help':
  case '--help':
  case '-h':
    printHelp()
    process.exit(0)
    break
  default:
    console.error(`Unknown Chrome MCP bridge command: ${command}`)
    printHelp()
    process.exit(1)
}
