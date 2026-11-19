import { L } from "@/lib/i18n";
/**
 * The no-session landing screen shown whenever there is no open project — on a
 * cold start and immediately after deleting the open session (`removeRecent`
 * clears `project`). It makes the empty state explicit instead of dropping the
 * user straight into Step 1's upload dropzone.
 *
 * Every action reuses an existing store/file helper; this screen owns no state
 * and adds no endpoints. Keep it calm: the one standout element (the glowing
 * dropzone) lives on Step 1 only.
 */

import { FolderOpen, History, Plus } from "lucide-react";
import { toast } from "sonner";

import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { openProjectFile } from "@/lib/projectFile";
import { STEP_LABELS, type RecentProject } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";

const RECENT_LIMIT = 4;

/** Older persisted entries may miss the workflow-activity clock. */
function activityOf(item: RecentProject): number {
  return typeof item.lastActivityAt === "number" ? item.lastActivityAt : item.updatedAt;
}

export function SessionLanding() {
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const createProject = useProjectStore((state) => state.createProject);
  const resumeRecent = useProjectStore((state) => state.resumeRecent);

  async function handleResume(item: RecentProject) {
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

  const recents = [...recentProjects]
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, RECENT_LIMIT);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center gap-8 px-8 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark variant="fine" className="size-12 text-muted-foreground/70" />
          <div className="space-y-1.5">
            <h1 className="text-xl font-medium text-foreground">
              {L("You're not in a session")}
            </h1>
            <p className="mx-auto max-w-prose text-sm leading-relaxed text-muted-foreground">
              {L("A session keeps one lecture's transcript, clips and subtitles together. Open a saved session to pick up where you left off, or create a new one to start with a lecture.")}
            </p>
          </div>
        </div>

        <div className="grid w-full gap-4 sm:grid-cols-2">
          {/* Create — same action as the sidebar's + and the Ctrl+K command. */}
          <section className="flex flex-col rounded-xl border border-border bg-card/40 p-5">
            <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-border bg-secondary/60">
              <Plus className="size-4 text-foreground/80" />
            </div>
            <h2 className="text-sm font-medium text-foreground">
              {L("Create new session")}
            </h2>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
              {L("Start with a fresh lecture. You'll transcribe the audio and find clips in Step 1.")}
            </p>
            <Button className="mt-4 w-full" onClick={() => createProject()}>
              <Plus className="size-4" />
              {L("Create new session")}
            </Button>
          </section>

          {/* Open — inline recents plus the same .tafseer opener as the sidebar. */}
          <section className="flex flex-col rounded-xl border border-border bg-card/40 p-5">
            <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-border bg-secondary/60">
              <FolderOpen className="size-4 text-foreground/80" />
            </div>
            <h2 className="text-sm font-medium text-foreground">{L("Open a session")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {L("Resume a recent session or open a saved .tafseer file.")}
            </p>

            {recents.length ? (
              <ul className="mt-3 space-y-1">
                {recents.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                      title={`Step ${item.step} of 4 · ${STEP_LABELS[item.step]}`}
                      onClick={() => void handleResume(item)}
                    >
                      <History className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {item.name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {relativeTime(item.updatedAt)}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-border px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {L("No recent sessions yet. Your sessions appear here automatically as you work.")}
              </p>
            )}

            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => void handleOpenFile()}
            >
              <FolderOpen className="size-4" />
              {L("Open a .tafseer file…")}
            </Button>
          </section>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/80">
          {L("Transcripts and clips stay on this machine. Settings are available from the Ctrl + K menu.")}
        </p>
      </div>
    </div>
  );
}
