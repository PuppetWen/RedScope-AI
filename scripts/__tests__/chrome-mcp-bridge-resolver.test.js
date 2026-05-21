import { describe, expect, test } from "bun:test";
import {
  getLocalRedScopeBridgeCliPath,
  resolveChromeMcpBridgeCliPath,
} from "../chrome-mcp-bridge-resolver.mjs";

describe("resolveChromeMcpBridgeCliPath", () => {
  test("default resolver locates the checked-in RedScope workspace shim", () => {
    const result = resolveChromeMcpBridgeCliPath();
    const normalizedPath = result.cliPath.replace(/\\/g, "/");

    expect(result.packageName).toBe("@redscope-ai/mcp-chrome-bridge");
    expect(result.source).toBe("workspace");
    expect(normalizedPath.endsWith("packages/mcp-chrome-bridge/dist/cli.js")).toBe(true);
  });

  test("prefers the local RedScope workspace shim when present", () => {
    const result = resolveChromeMcpBridgeCliPath({
      baseUrl: import.meta.url,
      exists: () => true,
      requireFn: {
        resolve() {
          throw new Error("should not resolve packages");
        },
      },
    });

    expect(result).toEqual({
      cliPath: getLocalRedScopeBridgeCliPath(import.meta.url),
      packageName: "@redscope-ai/mcp-chrome-bridge",
      source: "workspace",
    });
  });

  test("resolves the RedScope package when the workspace copy is unavailable", () => {
    const result = resolveChromeMcpBridgeCliPath({
      exists: () => false,
      requireFn: {
        resolve(specifier) {
          if (specifier === "@redscope-ai/mcp-chrome-bridge/dist/cli.js") {
            return "redscope-cli.js";
          }
          throw new Error("not found");
        },
      },
    });

    expect(result).toEqual({
      cliPath: "redscope-cli.js",
      packageName: "@redscope-ai/mcp-chrome-bridge",
      source: "package",
    });
  });

  test("throws a clear error when the RedScope bridge package cannot be resolved", () => {
    expect(() =>
      resolveChromeMcpBridgeCliPath({
        exists: () => false,
        requireFn: {
          resolve() {
            throw new Error("not found");
          },
        },
      }),
    ).toThrow("Unable to locate Chrome MCP bridge CLI");
  });
});
