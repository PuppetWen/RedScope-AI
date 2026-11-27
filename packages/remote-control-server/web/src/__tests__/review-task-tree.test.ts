import { describe, expect, test } from "bun:test";
import { ReviewTaskLedger, reviewTreeRows } from "../lib/review-task-tree";
import type { SessionEvent } from "../types";

function inbound(type: string, seqNum: number, raw: Record<string, unknown>): SessionEvent {
  return { type, seqNum, direction: "inbound", payload: { raw } };
}

function call(seq: number, callId: string, parent: string | null, role = "Explore") {
  return inbound("assistant", seq, {
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id: callId, name: "Agent", input: {
      subagent_type: role, description: "核对文档与源码", prompt: "private prompt",
    } }] },
  });
}

function lifecycle(seq: number, subtype: string, taskId: string, extra: Record<string, unknown>) {
  return inbound("system", seq, { subtype, task_id: taskId, ...extra });
}

describe("session review task tree", () => {
  test("rebuilds parallel siblings and nested review calls on replay", () => {
    const ledger = new ReviewTaskLedger();
    const history = [call(1, "a", null, "Plan"), call(2, "b", null),
      call(3, "c", "a", "claude-code-guide"),
      lifecycle(4, "task_started", "bg", { tool_use_id: "b", task_type: "local_agent" }),
      lifecycle(5, "task_progress", "bg", { description: "检查配置文档" })];
    for (const event of [...history, ...history]) ledger.apply(event);
    const rows = reviewTreeRows(ledger.snapshot());
    expect(rows.map(row => [row.node.id, row.depth])).toEqual([["a", 0], ["c", 1], ["b", 0]]);
    expect(rows[1].node.role).toBe("redscope-guide");
    expect(rows[2].node.activity).toBe("检查配置文档");
    expect(JSON.stringify(rows)).not.toContain("private prompt");
  });

  test("a background launch and an ordinary tool result are not evidence of completion", () => {
    const ledger = new ReviewTaskLedger();
    ledger.apply(call(1, "a", null));
    const reply = (status?: string) => inbound("user", 2, {
      message: { content: [{ type: "tool_result", tool_use_id: "a", content: "private output" }] },
      tool_use_result: { status },
    });
    ledger.apply(reply());
    expect(ledger.snapshot()[0].state).toBe("requested");
    ledger.apply(reply("async_launched"));
    expect(ledger.snapshot()[0].state).toBe("running");
    ledger.apply(lifecycle(5, "task_notification", "bg", { tool_use_id: "a", status: "stopped" }));
    ledger.apply(lifecycle(3, "task_started", "bg", { tool_use_id: "a" }));
    expect(ledger.snapshot()[0].state).toBe("stopped");
    expect(JSON.stringify(ledger.snapshot())).not.toContain("private output");
  });

  test("recovers a terminal event before its call, and accepts structured synchronous results", () => {
    const ledger = new ReviewTaskLedger();
    ledger.apply(lifecycle(4, "task_notification", "bg", { status: "failed" }));
    ledger.apply(lifecycle(2, "task_started", "bg", { tool_use_id: "a" }));
    ledger.apply(call(1, "a", null, "verification"));
    ledger.apply(call(5, "b", null));
    ledger.apply(inbound("user", 6, { message: { content: [{ type: "tool_result", tool_use_id: "b" }] },
      tool_use_result: { status: "completed" } }));
    expect(ledger.snapshot().map(n => n.state)).toEqual(["failed", "completed"]);
  });

  test("only projects named review calls from the current adapter's inbound stream", () => {
    const ledger = new ReviewTaskLedger();
    ledger.apply(call(1, "other", null, "general-purpose"));
    ledger.apply({ ...call(2, "echo", null), direction: "outbound" });
    ledger.apply(lifecycle(3, "task_started", "shell", { task_type: "local_bash", description: "private" }));
    expect(ledger.snapshot()).toEqual([]);
  });

  test("a batched reply cannot close multiple requests from one envelope status", () => {
    const ledger = new ReviewTaskLedger();
    ledger.apply(call(1, "a", null));
    ledger.apply(call(2, "b", null));
    ledger.apply(inbound("user", 3, {
      message: { content: [
        { type: "tool_result", tool_use_id: "a", is_error: true },
        { type: "tool_result", tool_use_id: "b" },
      ] },
      tool_use_result: { status: "completed" },
    }));
    expect(ledger.snapshot().map(n => n.state)).toEqual(["failed", "requested"]);
  });

  test("an incomplete or cyclic lineage renders every known node only once", () => {
    const ledger = new ReviewTaskLedger();
    ledger.apply(call(1, "a", "not-recorded"));
    ledger.apply(call(2, "b", "c"));
    ledger.apply(call(3, "c", "b"));
    const rows = reviewTreeRows(ledger.snapshot());
    expect(rows.map(row => row.node.id)).toEqual(["a", "b", "c"]);
    expect(rows.map(row => row.missingParent)).toEqual([true, true, false]);
  });
});
