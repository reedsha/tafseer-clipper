/**
 * One AI run: task, model, connection and (optionally) time and outcome.
 * Used in the busy cards and in the header's recent-activity popover.
 */

import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import {
  AI_TASK_LABEL,
  aiBackendLabel,
  aiStatusLabel,
  aiTimeLabel,
  type AiActivityEntry,
} from "@/lib/aiActivity";

interface AiActivityLineProps {
  entry: AiActivityEntry;
  /** Show when the run started and how it ended (used in the activity log). */
  detailed?: boolean;
  className?: string;
}

export function AiActivityLine({ entry, detailed = false, className }: AiActivityLineProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-relaxed text-muted-foreground",
        className,
      )}
    >
      <Badge
        variant="outline"
        className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
      >
        {AI_TASK_LABEL[entry.task]}
      </Badge>
      <span className="min-w-0 max-w-full truncate text-foreground/90">
        {entry.model || "model not chosen"}
      </span>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <span>{aiBackendLabel(entry.backend)}</span>
      {entry.detail ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span>{entry.detail}</span>
        </>
      ) : null}
      {detailed ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          <span className="tabular-nums">{aiTimeLabel(entry.startedAt)}</span>
          <span
            className={cn(
              "shrink-0",
              entry.status === "failed" && "text-status-warning",
            )}
          >
            {aiStatusLabel(entry.status)}
          </span>
        </>
      ) : null}
    </div>
  );
}
