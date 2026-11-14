import { Drawer } from "vaul";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import { Clock3, FileVideo2, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { openProjectFile } from "@/lib/projectFile";
import { STEP_LABELS } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function RecentProjectsDrawer() {
  const recentOpen = useUiStore((state) => state.recentOpen);
  const setRecentOpen = useUiStore((state) => state.setRecentOpen);

  const recentProjects = useProjectStore((state) => state.recentProjects);
  const resumeRecent = useProjectStore((state) => state.resumeRecent);
  const removeRecent = useProjectStore((state) => state.removeRecent);
  const createProject = useProjectStore((state) => state.createProject);

  async function handleOpenFile() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      setRecentOpen(false);
      toast.success("Project opened", { description: opened.name });
    } catch (error) {
      toast.error("Could not open project", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <Drawer.Root
      open={recentOpen}
      onOpenChange={setRecentOpen}
      direction="right"
      shouldScaleBackground={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px]" />
        <Drawer.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background outline-none"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="space-y-0.5">
              <Drawer.Title className="text-sm font-medium text-foreground">
                Recent lectures
              </Drawer.Title>
              <Drawer.Description className="text-xs text-muted-foreground">
                Auto-saved .tafseer snapshots. Resume at Step 2 or 3 without re-transcribing.
              </Drawer.Description>
            </div>
            <Drawer.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close recent lectures">
                <X className="size-4" />
              </Button>
            </Drawer.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {recentProjects.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Clock3 className="size-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  No auto-saved lectures yet. Import a lecture on Step 1 to begin.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {recentProjects.map((item) => (
                  <li key={item.id}>
                    <div
                      className={cn(
                        "group flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-2",
                        "transition-colors hover:bg-accent/40",
                      )}
                    >
                      <Button
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 px-0 py-0 text-left font-normal hover:bg-transparent"
                        onClick={async () => {
                          const resumed = await resumeRecent(item.id);
                          if (resumed) {
                            setRecentOpen(false);
                            toast.success("Lecture resumed", {
                              description: `${item.name} · Step ${item.step}`,
                            });
                          } else {
                            toast.error("Auto-save not found", {
                              description:
                                "No .tafseer snapshot was found for this lecture on disk or in local storage.",
                            });
                          }
                        }}
                      >
                        <span className="flex items-center gap-1.5">
                          <FileVideo2 className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-medium text-foreground">
                            {item.name}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate pl-5 text-[11px] text-muted-foreground">
                          Step {item.step} · {STEP_LABELS[item.step]} · {item.clipCount} clip
                          {item.clipCount === 1 ? "" : "s"} · {relativeTime(item.updatedAt)}
                        </span>
                      </Button>

                      {typeof item.duration === "number" && item.duration > 0 ? (
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          <NumberFlow
                            value={Math.round(item.duration / 60)}
                            suffix=" min"
                            format={{ maximumFractionDigits: 0 }}
                          />
                        </span>
                      ) : null}

                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${item.name} from recent lectures`}
                        onClick={() => {
                          removeRecent(item.id);
                          toast.success("Removed from recent lectures");
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void handleOpenFile()}
            >
              <FolderOpen className="size-3.5" />
              Open .tafseer
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => {
                createProject();
                setRecentOpen(false);
              }}
            >
              <Plus className="size-3.5" />
              New project
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
