import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { isFinished, reviewTreeRows, type ReviewState, type ReviewTaskNode } from "../lib/review-task-tree";

interface TaskPanelProps {
  nodes: ReviewTaskNode[];
  sessionTitle: string;
  closed: boolean;
  onClose: () => void;
}

const labels: Record<ReviewState, string> = {
  requested: "已请求",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const colors: Record<ReviewState, string> = {
  requested: "border-text-muted",
  running: "border-status-running bg-status-running",
  completed: "border-status-active bg-status-active",
  failed: "border-status-error bg-status-error",
  stopped: "border-text-secondary bg-text-secondary",
};

export function TaskPanel({ nodes, sessionTitle, closed, onClose }: TaskPanelProps) {
  const completed = nodes.filter(node => node.state === "completed").length;
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        className="inset-y-0 right-0 left-auto flex h-full max-h-none w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-l bg-surface-1 p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b border-border p-5 pr-12 text-left">
          <DialogTitle className="font-display font-semibold text-text-primary">审阅任务树</DialogTitle>
          <DialogDescription className="break-words">{sessionTitle}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto p-5">
          {nodes.length === 0 ? (
            <p className="text-sm text-text-secondary">当前会话还没有代码探索、方案审阅、产品指南或验收任务记录。</p>
          ) : (
            <>
              <p role="status" className="mb-4 text-sm text-text-secondary">
                {nodes.length} 项审阅任务 · {completed} 项已完成
              </p>
              <ol aria-label="Agent 派生关系" className="space-y-2">
                {reviewTreeRows(nodes).map(({ node, depth, missingParent }) => {
                  const unconfirmed = closed && !isFinished(node.state);
                  return (
                    <li key={node.id} style={{ marginInlineStart: Math.min(depth, 5) * 14 }}
                      className="relative rounded-md border border-border bg-surface-2 p-3">
                      {depth > 0 && <span aria-hidden className="absolute -left-3 top-5 h-px w-3 bg-text-muted" />}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs text-text-secondary">{node.role}</span>
                        <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                          <span aria-hidden className={`size-2 rounded-full border ${unconfirmed ? "border-text-muted" : colors[node.state]}`} />
                          {unconfirmed ? "结束状态未记录" : labels[node.state]}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-sm font-medium text-text-primary">{node.title}</p>
                      {node.activity && node.activity !== node.title &&
                        <p className="mt-1 break-words text-xs text-text-secondary">{node.activity}</p>}
                      {missingParent && <p className="mt-1 text-xs text-text-secondary">上级关系未收录</p>}
                      {depth > 0 && <span className="sr-only">子任务层级 {depth}</span>}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
