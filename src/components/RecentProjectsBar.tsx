import NumberFlow from "@number-flow/react";
import { FileVideo2, FolderOpen, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatLectureDuration, relativeTime } from "@/lib/format";
import { STEP_LABELS, type RecentProject } from "@/lib/projectTypes";

/**
 * Recent Lectures bar — exactly two intended surfaces (master plan §4):
 * 1. `compact`: the app-shell strip above the stepper (the opening affordance).
 * 2. non-compact: the Step 1 card strip (header row + resume cards).
 * The compact strip renders the inline single-row list; the Step 1 surface
 * renders only cards, so no lecture is listed twice on one screen.
 */
export function RecentProjectsBar({
  recentProjects,
  onResume,
  onOpenFile,
  onViewAll,
  compact = false,
  lastProjectId,
}: {
  recentProjects: RecentProject[];
  onResume: (id: string) => void;
  onOpenFile: () => void;
  onViewAll: () => void;
  /** Slim single-row strip for the app shell above the stepper. */
  compact?: boolean;
  /** Id of the most recently opened project; that entry leads with a caption. */
  lastProjectId?: string | null;
}) {
  // The last-opened project leads the strip and gains a "Continue" caption so
  // a reload isn't a dead end for the open project (contract-safe: this stays
  // inside the Recent Lectures bar; no modal, no auto-restore).
  const ordered = [...recentProjects].sort((a, b) => {
    if (a.id === lastProjectId) return -1;
    if (b.id === lastProjectId) return 1;
    return b.updatedAt - a.updatedAt;
  });
  const isLastOpen = (id: string) => lastProjectId != null && id === lastProjectId;
  return (
    <section
      className={
        compact
          ? "shrink-0 border-b border-border bg-card/20 px-4 py-1.5"
          : "rounded-lg border border-border bg-card/30"
      }
      aria-label="Recent lectures"
    >
      <div
        className={
          compact
            ? "flex items-center gap-2"
            : "flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5"
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          <History className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Recent lectures</span>
          {compact ? null : (
            <span className="text-[10px] text-muted-foreground">Auto-saved .tafseer</span>
          )}
        </div>

        {compact ? (
          recentProjects.length === 0 ? (
            <p className="truncate text-[11px] text-muted-foreground">
              No auto-saved lectures yet.
            </p>
          ) : (
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
              {ordered.slice(0, 4).map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  size="xs"
                  onClick={() => onResume(item.id)}
                  className="h-auto min-w-0 shrink-0 flex-col items-start gap-0.5 px-2 py-1 text-left font-normal"
                >
                  <span className="flex max-w-[220px] items-center gap-1.5">
                    <FileVideo2 className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate text-[11px] font-medium text-foreground">
                      {item.name}
                    </span>
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {isLastOpen(item.id) ? "Continue where you left off · " : ""}
                    Step {item.step} · {STEP_LABELS[item.step]} · {item.clipCount} clip
                    {item.clipCount === 1 ? "" : "s"} · {relativeTime(item.updatedAt)}
                  </span>
                </Button>
              ))}
            </div>
          )
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="xs" className="gap-1.5" onClick={onOpenFile}>
            <FolderOpen className="size-3" />
            Open .tafseer
          </Button>
          <Button variant="ghost" size="xs" onClick={onViewAll}>
            View all
          </Button>
        </div>
      </div>

      {!compact && recentProjects.length === 0 ? (
        <p className="px-4 py-3 text-[11px] text-muted-foreground">
          Your first import appears here so you can resume at Step 2 or 3 without
          re-transcribing.
        </p>
      ) : null}

      {!compact && recentProjects.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto px-3 py-2.5">
          {ordered.slice(0, 8).map((item) => {
            const duration =
              typeof item.duration === "number" && item.duration > 0
                ? formatLectureDuration(item.duration)
                : null;
            return (
              <Button
                key={`card-${item.id}`}
                variant="ghost"
                onClick={() => onResume(item.id)}
                className="group h-auto w-[236px] shrink-0 flex-col items-start justify-start gap-1 rounded-md border border-border bg-background/40 px-3 py-2 text-left font-normal hover:bg-accent/40"
              >
                <span className="flex w-full items-center gap-1.5">
                  <FileVideo2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium text-foreground">
                    {item.name}
                  </span>
                </span>
                <span className="w-full truncate text-[10px] text-muted-foreground">
                  {isLastOpen(item.id) ? "Continue where you left off · " : ""}
                  Step {item.step} · {STEP_LABELS[item.step]} · {item.clipCount} clip
                  {item.clipCount === 1 ? "" : "s"} · {relativeTime(item.updatedAt)}
                </span>
                {duration ? (
                  <span className="text-[10px] tabular-nums text-muted-foreground/80">
                    <NumberFlow
                      value={duration.value}
                      suffix={duration.suffix}
                      format={{ maximumFractionDigits: 0 }}
                    />
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
