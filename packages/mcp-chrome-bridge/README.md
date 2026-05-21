# @redscope-ai/mcp-chrome-bridge

RedScope-scoped package for the Chrome MCP bridge.

The root RedScope package depends on this RedScope-scoped package boundary
instead of directly depending on the legacy bridge. The runtime files are
vendored under this package so RedScope no longer imports or delegates to the
legacy registry package internally.

This package is publishable as a public compatibility shim. A first release can
be cut after logging in to an npm account that can publish under the
`@redscope-ai` scope:

```bash
npm publish --access public
```

Compatibility boundaries:

- Keep the existing `mcp-chrome-bridge` and `mcp-chrome-stdio` bin names.
- Preserve the upstream CLI argument surface.
- Do not change Chrome native-host registration behavior during the vendor
  transition.

Setup environment:

- Prefer `REDSCOPE_SKIP_CHROME_MCP_SETUP=1` to skip automatic native-host setup
  during RedScope postinstall.
- `CLAUDE_CODE_SKIP_CHROME_MCP_SETUP=1` is still accepted as a legacy
  compatibility alias.
