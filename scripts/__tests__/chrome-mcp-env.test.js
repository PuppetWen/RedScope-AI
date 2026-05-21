import { describe, expect, test } from "bun:test";
import {
  LEGACY_SKIP_CHROME_MCP_SETUP,
  REDSCOPE_SKIP_CHROME_MCP_SETUP,
  shouldSkipChromeMcpSetup,
} from "../chrome-mcp-env.mjs";

describe("shouldSkipChromeMcpSetup", () => {
  test("prefers the RedScope skip env var", () => {
    expect(
      shouldSkipChromeMcpSetup({
        [REDSCOPE_SKIP_CHROME_MCP_SETUP]: "1",
      }),
    ).toBe(true);
  });

  test("keeps the legacy skip env var as a compatibility alias", () => {
    expect(
      shouldSkipChromeMcpSetup({
        [LEGACY_SKIP_CHROME_MCP_SETUP]: "true",
      }),
    ).toBe(true);
  });

  test("does not skip when neither alias is truthy", () => {
    expect(
      shouldSkipChromeMcpSetup({
        [REDSCOPE_SKIP_CHROME_MCP_SETUP]: "0",
        [LEGACY_SKIP_CHROME_MCP_SETUP]: "",
      }),
    ).toBe(false);
  });
});
