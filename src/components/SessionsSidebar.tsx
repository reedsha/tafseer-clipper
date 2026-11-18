/**
 * Sessions sidebar — the always-present list of auto-saved sessions (formerly
 * the "Recent lectures" bar + "View all" drawer). Not collapsible.
 *
 * A header with count + New session / Open .tafseer, then one row per session
 * grouped by day. The whole row card resumes the session on click (inline
 * rename on double-click or the pencil, remove on the trash), and a slim
 * footer reports auto-save state.
 */

import { useEffect, useRef, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  FileVideo2,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { formatLectureDuration, relativeTime } from "@/lib/format";
import { openProjectFile } from "@/lib/projectFile";
import { STEP_LABELS, type RecentProject } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";

/** "Today" / "Yesterday" / "Earlier" bucket for the list separators. */
function dayBucket(timestamp: number): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (timestamp >= todayStart) return "Today";
  if (timestamp >= todayStart - 86_400_000) return "Yesterday";
  return "Earlier";
}

/**
 * When the session was last *worked on* — not merely opened or auto-saved.
 * Older persisted entries may miss the field, so fall back to updatedAt.
 */
function activityOf(item: RecentProject): number {
  return typeof item.lastActivityAt === "number" ? item.lastActivityAt : item.updatedAt;
}

const STEP_COUNT = 4;

export function SessionsSidebar() {
  const project = useProjectStore((state) => state.project);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const autosavedAt = useProjectStore((state) => state.autosavedAt);
  const lastAutosaveError = useProjectStore(
    (state) => state.lastAutosaveError,
  );
  const resumeRecent = useProjectStore((state) => state.resumeRecent);
  const removeRecent = useProjectStore((state) => state.removeRecent);
  const renameSession = useProjectStore((state) => state.renameSession);
  const createProject = useProjectStore((state) => state.createProject);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** Session awaiting removal confirmation; `null` keeps the dialog closed. */
  const [pendingRemove, setPendingRemove] = useState<RecentProject | null>(null);

  // Re-render once a minute so "2 h ago" / "Auto-saved" stay honest without
  // any store activity.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.select();
  }, [renamingId]);

  async function handleResume(item: RecentProject) {
    if (item.id === project?.id) return;
    const resumed = await resumeRecent(item.id);
    if (resumed) {
      toast.success("Session resumed", {
        description: `${item.name} · Step ${item.step}`,
      });
    } else {
      toast.error("Auto-save not found", {
        description:
          "No .tafseer snapshot was found for this session on disk or in local storage.",
      });
    }
  }

  function commitRename(id: string) {
    renameSession(id, renameValue);
    setRenamingId(null);
  }

  async function handleOpenFile() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      toast.success("Session opened", { description: opened.name });
    } catch (error) {
      toast.error("Could not open session", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let lastBucket: string | null = null;

  // The store list is sorted by save time; the group order must be by activity
  // time so the Today/Yesterday/Earlier separators never interleave.
  const orderedProjects = [...recentProjects].sort(
    (a, b) => activityOf(b) - activityOf(a),
  );

  return (
    <aside
      aria-label="Sessions"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-card/20"
    >
      <div className="flex items-center justify-between gap-1 px-3 pb-1 pt-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          Sessions
          {recentProjects.length > 0 ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-[10px] tabular-nums"
            >
              {recentProjects.length}
            </Badge>
          ) : null}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New session"
            title="New session"
            onClick={() => createProject()}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open .tafseer"
            title="Open a .tafseer file"
            onClick={() => void handleOpenFile()}
          >
            <FolderOpen className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {recentProjects.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            No sessions yet. Choose “Create new session” on the start screen to
            begin — every lecture is auto-saved here so you can resume without
            re-transcribing.
          </p>
        ) : (
          <ul className="space-y-1">
            {orderedProjects.map((item) => {
              const active = item.id === project?.id;
              const duration =
                typeof item.duration === "number" && item.duration > 0
                  ? formatLectureDuration(item.duration)
                  : null;
              const bucket = dayBucket(activityOf(item));
              const showBucket = bucket !== lastBucket;
              const firstBucket = lastBucket === null;
              lastBucket = bucket;
              const cardClass = cn(
                "relative rounded-md border",
                active
                  ? "border-ring/40 bg-accent/50"
                  : "border-transparent",
              );
              return (
                <li key={item.id}>
                  {showBucket ? (
                    <p
                      aria-hidden="true"
                      className={cn(
                        "px-1.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70",
                        firstBucket && "pt-0.5",
                      )}
                    >
                      {bucket}
                    </p>
                  ) : null}
                  <div className="group relative">
                    {renamingId === item.id ? (
                      <div className={cn(cardClass, "px-2.5 py-2")}>
                        <Input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onBlur={() => commitRename(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitRename(item.id);
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                          aria-label="Session name"
                          className="h-6 px-1.5 text-xs"
                          autoFocus
                        />
                      </div>
                    ) : (
                      /* The card itself is the resume button: every part of a
                         session's row — name, meta, progress, padding — is one
                         click target. The rename/remove actions live outside
                         it as absolutely positioned siblings so interactive
                         elements are never nested. */
                      <Button
                        variant="ghost"
                        className={cn(
                          cardClass,
                          "flex h-auto w-full flex-col items-stretch gap-1 px-2.5 py-2 text-left font-normal",
                          !active && "hover:border-border hover:bg-accent/30",
                        )}
                        onClick={() => void handleResume(item)}
                        onDoubleClick={() => {
                          setRenamingId(item.id);
                          setRenameValue(item.name);
                        }}
                        aria-label={`Resume ${item.name}`}
                        aria-current={active ? "true" : undefined}
                      >
                        {active ? (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-ring/60"
                          />
                        ) : null}
                        <div className="flex items-center gap-1.5">
                          <FileVideo2 className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                            {item.name}
                          </span>
                          {/* The timestamp fades out while the row actions
                              (positioned over it) fade in on hover. */}
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                            {relativeTime(item.updatedAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 pl-5">
                          <Progress
                            value={(item.step / STEP_COUNT) * 100}
                            aria-hidden="true"
                            className="h-0.5 w-7 shrink-0 bg-border/60"
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                            title={`Step ${item.step} of ${STEP_COUNT} · ${STEP_LABELS[item.step]}`}
                          >
                            {STEP_LABELS[item.step]} · {item.clipCount} clip
                            {item.clipCount === 1 ? "" : "s"}
                            {duration ? (
                              <>
                                {" · "}
                                <span className="sr-only">Lecture duration: </span>
                                <NumberFlow
                                  value={duration.value}
                                  suffix={duration.suffix}
                                  format={{ maximumFractionDigits: 0 }}
                                />
                              </>
                            ) : null}
                          </span>
                        </div>
                      </Button>
                    )}
                    {renamingId !== item.id ? (
                      <div className="absolute right-1 top-1.5 flex h-4 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Rename ${item.name}`}
                          title="Rename (or double-click the row)"
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameValue(item.name);
                          }}
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${item.name}`}
                          title="Remove this session's auto-save"
                          onClick={() => setPendingRemove(item)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-3 py-1.5">
        <p
          className={cn(
            "truncate text-[10px]",
            lastAutosaveError
              ? "text-destructive"
              : "text-muted-foreground/80",
          )}
          title={lastAutosaveError ?? undefined}
        >
          {lastAutosaveError
            ? "Auto-save failed — changes are at risk"
            : project
              ? `Auto-saved ${autosavedAt ? relativeTime(autosavedAt) : "…"}`
              : "Auto-save is on"}
        </p>
      </div>

      {/* Removing a session deletes its auto-save for good, so it asks once. */}
      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove ? (
                <>
                  <span className="font-medium text-foreground">
                    {pendingRemove.name}
                  </span>{" "}
                  and its auto-save snapshot (.tafseer) will be deleted. The
                  original video and any clips you already exported are not
                  affected. If this is the open session, you'll return to the
                  start screen.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">Keep session</Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!pendingRemove) return;
                  removeRecent(pendingRemove.id);
                  toast.success("Session removed", {
                    description: pendingRemove.name,
                  });
                  setPendingRemove(null);
                }}
              >
                Remove session
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
