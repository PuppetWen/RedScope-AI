import type { SessionEvent } from "../types";

const roleNames = new Map([
  ["Explore", "Explore"],
  ["Plan", "Plan"],
  ["verification", "verification"],
  ["redscope-guide", "redscope-guide"],
  ["claude-code-guide", "redscope-guide"],
]);

export type ReviewState = "requested" | "running" | "completed" | "failed" | "stopped";
export type ReviewTaskNode = {
  id: string;
  /** null is an explicit top-level call; undefined means the producer did not say. */
  parent: string | null | undefined;
  role: string;
  title: string;
  state: ReviewState;
  activity?: string;
};

type Progress = { state: ReviewState; seq: number; activity?: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function label(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

export function isFinished(state: ReviewState) {
  return state === "completed" || state === "failed" || state === "stopped";
}

// A delayed start or progress event cannot reopen a finished task.
function latest(a: Progress | undefined, b: Progress | undefined): Progress | undefined {
  if (!a || !b) return a ?? b;
  if (isFinished(a.state) !== isFinished(b.state)) return isFinished(a.state) ? a : b;
  return a.seq > b.seq ? a : b;
}

/** Read-only projection of review role calls in one session. Keeps labels, IDs and state only. */
export class ReviewTaskLedger {
  private calls = new Map<string, Omit<ReviewTaskNode, "state" | "activity">>();
  private taskForCall = new Map<string, string>();
  private callForTask = new Map<string, string>();
  private taskProgress = new Map<string, Progress>();
  private callResults = new Map<string, Progress>();
  private sequence = 0;

  apply(event: SessionEvent): boolean {
    if (event.direction === "outbound") return false;
    const envelope = record(event.payload);
    const p = { ...record(envelope.raw), ...envelope };
    const seq = event.seqNum ?? this.sequence + 1;
    this.sequence = Math.max(this.sequence, seq);
    if (event.type === "system") {
      const taskId = id(p.task_id);
      if (!taskId) return false;
      const callId = id(p.tool_use_id) ?? this.callForTask.get(taskId);
      const subtype = p.subtype;
      let state: ReviewState;
      if (subtype === "task_notification" &&
          (p.status === "completed" || p.status === "failed" || p.status === "stopped")) {
        state = p.status;
      } else if (subtype === "task_started" || subtype === "task_progress") {
        if (p.task_type && p.task_type !== "local_agent") return false;
        state = "running";
      } else {
        return false;
      }
      if (callId) {
        this.taskForCall.set(callId, taskId);
        this.callForTask.set(taskId, callId);
      }
      const visible = !!callId && this.calls.has(callId);
      const update = { state, seq, activity: state === "running" && visible ? label(p.description) : undefined };
      this.taskProgress.set(taskId, latest(this.taskProgress.get(taskId), update)!);
      return visible;
    }

    if (event.type !== "assistant" && event.type !== "user" &&
        event.type !== "tool_use" && event.type !== "tool_result") return false;
    const content = record(p.message).content;
    const blocks = Array.isArray(content) ? content : [];
    const parent = p.parent_tool_use_id === null ? null : id(p.parent_tool_use_id);
    const result = record(p.tool_use_result);
    let changed = false;
    if (event.type === "tool_use") {
      changed = this.addCall(p.tool_call_id, p.tool_name, p.tool_input, parent);
    } else if (event.type === "tool_result") {
      changed = this.addResult(p.tool_call_id, p.is_error, result.status, seq);
    } else {
      // An SDK result envelope can describe only one tool call. In a batched
      // reply rely on per-block errors or individual lifecycle notifications.
      const resultStatus = event.type === "user" &&
        blocks.filter(item => record(item).type === "tool_result").length === 1
        ? result.status : undefined;
      for (const item of blocks) {
        const block = record(item);
        if (event.type === "assistant" && block.type === "tool_use") {
          if (this.addCall(block.id, block.name, block.input, parent)) changed = true;
        } else if (event.type === "user" && block.type === "tool_result") {
          if (this.addResult(block.tool_use_id, block.is_error, resultStatus, seq)) changed = true;
        }
      }
    }
    return changed;
  }

  private addCall(callId: unknown, name: unknown, input: unknown, parent: ReviewTaskNode["parent"]) {
    const key = id(callId);
    if (!key || (name !== "Agent" && name !== "Task")) return false;
    const fields = record(input);
    const role = roleNames.get(label(fields.subagent_type));
    if (!role) return false;
    const prev = this.calls.get(key);
    const title = label(fields.description) || prev?.title || role;
    const resolvedParent = parent === undefined ? prev?.parent : parent;
    if (prev && prev.title === title && prev.parent === resolvedParent && prev.role === role) return false;
    this.calls.set(key, { id: key, parent: resolvedParent, role, title });
    return true;
  }

  private addResult(callId: unknown, error: unknown, status: unknown, seq: number) {
    const key = id(callId);
    if (!key) return false;
    // A background launch also returns a normal tool_result. Only a structured
    // completion or task_notification can establish that the work finished.
    let state: ReviewState | undefined;
    if (error === true) state = "failed";
    else if (status === "completed") state = "completed";
    else if (status === "async_launched" || status === "remote_launched" || status === "teammate_spawned") state = "running";
    if (!state || (!this.calls.has(key) && !status)) return false;
    const update: Progress = { state, seq };
    this.callResults.set(key, latest(this.callResults.get(key), update)!);
    return this.calls.has(key);
  }

  snapshot(): ReviewTaskNode[] {
    return Array.from(this.calls.values(), call => {
      const task = this.taskForCall.get(call.id);
      const progress = latest(task ? this.taskProgress.get(task) : undefined, this.callResults.get(call.id));
      return { ...call, state: progress?.state ?? "requested", activity: progress?.activity };
    });
  }
}

export type ReviewTreeRow = { node: ReviewTaskNode; depth: number; missingParent: boolean };

/** Flatten for rendering, preserving siblings' arrival order and tolerating incomplete history. */
export function reviewTreeRows(nodes: ReviewTaskNode[]): ReviewTreeRow[] {
  const ids = new Set(nodes.map(node => node.id));
  const children = new Map<string, ReviewTaskNode[]>();
  const roots: ReviewTaskNode[] = [];
  for (const node of nodes) {
    if (node.parent && ids.has(node.parent)) {
      const siblings = children.get(node.parent) ?? [];
      siblings.push(node);
      children.set(node.parent, siblings);
    } else {
      roots.push(node);
    }
  }
  const rows: ReviewTreeRow[] = [];
  const seen = new Set<string>();
  function visit(root: ReviewTaskNode, missingParent: boolean) {
    const stack = [{ node: root, depth: 0, missingParent }];
    while (stack.length) {
      const row = stack.pop()!;
      if (seen.has(row.node.id)) continue;
      seen.add(row.node.id);
      rows.push(row);
      const next = children.get(row.node.id) ?? [];
      for (let i = next.length - 1; i >= 0; i--) {
        stack.push({ node: next[i], depth: row.depth + 1, missingParent: false });
      }
    }
  }
  for (const root of roots) visit(root, root.parent !== null);
  for (const node of nodes) if (!seen.has(node.id)) visit(node, true);
  return rows;
}
