import { useEffect } from "react";
import { VideoOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { L } from "@/lib/i18n";
import { relinkLecture } from "@/lib/sourceLink";
import { useProjectStore } from "@/store/projectStore";

/**
 * Calm, non-blocking notice that the open session's lecture can't be read at its
 * saved path (typically a disconnected external drive). Offers the
 * non-destructive re-link; trimming and the waveform keep working regardless.
 * Re-checks on window focus so reconnecting the drive clears the banner.
 */
export function SourceMissingBanner() {
  const status = useProjectStore((state) => state.sourceStatus);
  const project = useProjectStore((state) => state.project);
  const refreshSourceStatus = useProjectStore((state) => state.refreshSourceStatus);

  useEffect(() => {
    if (status !== "missing") return;
    const recheck = () => {
      if (!document.hidden) void refreshSourceStatus();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [status, refreshSourceStatus]);

  if (status !== "missing" || !project) return null;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 py-2">
      <VideoOff className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {L("Lecture can't be opened at its saved location.")}{" "}
        <span className="text-muted-foreground/70">
          {project.sourceFileName ?? project.sourcePath}
        </span>
      </p>
      <Button variant="outline" size="xs" onClick={() => void relinkLecture()}>
        {L("Re-link lecture")}
      </Button>
    </div>
  );
}
