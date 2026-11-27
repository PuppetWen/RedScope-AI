import { afterEach, expect, test } from "bun:test";
import { RCSChatAdapter } from "../lib/rcs-chat-adapter";
import type { ReviewTaskNode } from "../lib/review-task-tree";
import type { SessionEvent } from "../types";

class MockStream {
  static instances: MockStream[] = [];
  onmessage?: (message: { data: string }) => void;
  closed = false;

  constructor(public url: string) {
    MockStream.instances.push(this);
  }

  send(event: SessionEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close() {
    this.closed = true;
  }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(key: string, value: unknown) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function setup(history: () => Response | Promise<Response>) {
  MockStream.instances = [];
  replaceGlobal("localStorage", { getItem: () => "test-owner" });
  replaceGlobal("EventSource", MockStream);
  replaceGlobal("fetch", (url: string) => url.includes("/history") ? history() : Response.json({}));
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test("replays a local review and follows the same session from the history cursor", async () => {
  setup(() => Response.json({ events: [{
    type: "assistant", direction: "inbound", seqNum: 1, payload: {
      message: { content: [{
        type: "tool_use", id: "call", name: "Agent",
        input: { subagent_type: "Explore", description: "核对本地报告路径" },
      }] },
      raw: { parent_tool_use_id: null },
    },
  }] }));
  const updates: ReviewTaskNode[][] = [];
  const adapter = new RCSChatAdapter("session-1", () => {}, { onTasksChange: rows => updates.push(rows) });
  await adapter.init();
  const source = MockStream.instances[0]!;
  expect(source.url).toContain("/session-1/events?");
  expect(source.url).toContain("after=1");
  expect(updates[updates.length - 1]?.[0]).toMatchObject({ title: "核对本地报告路径", parent: null, state: "requested" });

  const terminal: SessionEvent = {
    type: "system", seqNum: 2, direction: "inbound",
    payload: { raw: { subtype: "task_notification", task_id: "task", tool_use_id: "call", status: "completed" } } as SessionEvent["payload"],
  };
  source.send(terminal);
  source.send(terminal);
  expect(updates).toHaveLength(2);
  expect(updates[1]?.[0]?.state).toBe("completed");
  adapter.disconnect();
  expect(source.closed).toBe(true);
});

test("a session closed between its detail and history snapshots does not subscribe", async () => {
  setup(() => Response.json({ events: [
    { type: "session_status", seqNum: 1, direction: "inbound", payload: { status: "archived" } },
  ] }));
  const states: string[] = [];
  const adapter = new RCSChatAdapter("archived", () => {}, { onStatusChange: status => states.push(status) });
  await adapter.init();
  expect(states).toEqual(["archived"]);
  expect(MockStream.instances).toHaveLength(0);
});

test("leaving during history fetch cannot recreate a disconnected session stream", async () => {
  let release!: (r: Response) => void;
  let fetched!: () => void;
  const started = new Promise<void>(resolve => { fetched = resolve; });
  setup(() => {
    fetched();
    return new Promise<Response>(resolve => { release = resolve; });
  });
  let published = false;
  const adapter = new RCSChatAdapter("old-session", () => { published = true; });
  const loading = adapter.init();
  await started;
  adapter.disconnect();
  release(Response.json({ events: [] }));
  await loading;
  expect(published).toBe(false);
  expect(MockStream.instances).toHaveLength(0);
});
