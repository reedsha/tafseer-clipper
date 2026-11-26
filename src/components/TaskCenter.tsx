import { L } from "@/lib/i18n";
/**
 * Header task center: one calm place to see work that outlived the step that
 * started it. Renders nothing when no job is running, so the chrome stays quiet
 * (AGENTS.md §1, Layer 3 "calm everywhere else").
 */

import { useState } from "react";
import NumberFlow from "@number-flow/react";
import { ListTodo, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useJobStore, type TaskJob } from "@/store/jobStore";
import { useProjectStore } from "@/store/projectStore";
import { useRenderStore } from "@/store/renderStore";

function projectName(id: string | null, recents: { id: string; name: string }[]): string {
  if (!id) return "Session";
  return recents.find((item) => item.id === id)?.name ?? "Session";
}

function TaskRow({
  label,
  project,
  stageLabel,
  progress,
  onCancel,
}: {
  label: string;
  project: string;
  stageLabel?: string | null;
  /** 0..1, or `null` for an indeterminate task. */
  progress: number | null;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Cancel ${label}`}
          title={`Cancel ${label}`}
          onClick={onCancel}
          className="shrink-0 text-muted-foreground"
        >
          <X className="size-3" />
        </Button>
      </div>
      <p className="truncate text-[11px] text-muted-foreground">{project}</p>
      {stageLabel ? (
        <p className="truncate text-[10px] text-muted-foreground/85">{stageLabel}</p>
      ) : null}
      {progress !== null ? (
        <div className="mt-1 flex items-center gap-2">
          <Progress value={Math.round(progress * 100)} className="h-1" />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            <NumberFlow value={Math.round(progress * 100)} suffix="%" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function TaskCenter() {
  const jobs = useJobStore((state) => state.jobs);
  const cancelJob = useJobStore((state) => state.cancelJob);
  const renderJob = useRenderStore((state) => state.job);
  const recents = useProjectStore((state) => state.recentProjects);
  const [open, setOpen] = useState(false);

  const running = jobs.filter((job) => job.status === "running");
  const renderRunning = renderJob.status === "running";
  const total = running.length + (renderRunning ? 1 : 0);
  if (total === 0) return null;

  const progressOf = (job: TaskJob): number | null =>
    job.progress ? job.progress.done / Math.max(1, job.progress.total) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${total} running task${total === 1 ? "" : "s"}`}
          title={`${total} running task${total === 1 ? "" : "s"}`}
          className="h-auto gap-1.5 px-2 py-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          <ListTodo className="size-3.5" />
          <span className="tabular-nums">{total}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          {L("Running tasks")}
        </p>
        <div className="space-y-1.5">
          {running.map((job) => (
            <TaskRow
              key={job.id}
              label={job.label}
              project={projectName(job.projectId, recents)}
              stageLabel={job.stageLabel}
              progress={progressOf(job)}
              onCancel={() => cancelJob(job.id)}
            />
          ))}
          {renderRunning ? (
            <TaskRow
              label={L("Rendering clips")}
              project={projectName(renderJob.projectId, recents)}
              progress={renderJob.overall}
              onCancel={() => useRenderStore.getState().cancelRender()}
            />
          ) : null}
        </div>
        <p className="px-1 pt-2 text-[10px] leading-relaxed text-muted-foreground">
          {L("These keep running when you change steps or sessions.")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
