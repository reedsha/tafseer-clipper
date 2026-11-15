import NumberFlow from "@number-flow/react";
import { Check, Command, History, Settings } from "lucide-react";
import { cn } from "cn";

import { BrandMark } from "@/components/BrandMark";
import {
  SIDECAR_STATUS_LABEL,
  SidecarStatusDot,
} from "@/components/SidecarStatusDot";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SIDECAR_URL } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import { STEP_LABELS, type WizardStep } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useRenderStore } from "@/store/renderStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

const STEPS: WizardStep[] = [1, 2, 3, 4];

/**
 * A step is complete when its work exists, not merely because the wizard moved
 * past it (a project with no transcript at Step 4 must not show ✓ on 1–3).
 */
function stepCompletion(
  step: WizardStep,
  project: ReturnType<typeof useProjectStore.getState>["project"],
  renderDoneForProject: boolean,
): boolean {
  if (!project) return false;
  switch (step) {
    case 1:
      return Boolean(project.transcriptId && project.transcript);
    case 2:
      return project.clips.some((clip) => clip.approved);
    case 3: {
      const approved = project.clips.filter((clip) => clip.approved);
      return (
        approved.length > 0 &&
        approved.every((clip) =>
          (project.subtitles[clip.id] ?? []).some((cue) => cue.arabic || cue.thai),
        )
      );
    }
    case 4:
      return renderDoneForProject;
  }
}

export function StepperHeader() {
  const project = useProjectStore((state) => state.project);
  const setStep = useProjectStore((state) => state.setStep);
  const recentCount = useProjectStore((state) => state.recentProjects.length);

  const sidecar = useSettingsStore((state) => state.sidecar);
  const toggleCommand = useUiStore((state) => state.toggleCommand);
  const openSettings = useUiStore((state) => state.openSettings);
  const setRecentOpen = useUiStore((state) => state.setRecentOpen);

  const currentStep = project?.step ?? 1;
  const status = sidecar.status;
  /** Vendor-neutral acceleration state for the status tooltip. */
  const acceleration = describeAcceleration(sidecar.health);
  const renderJob = useRenderStore((state) => state.job);
  const renderDoneForProject =
    renderJob.projectId !== null &&
    renderJob.projectId === project?.id &&
    renderJob.status === "done";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/30 px-4">
      <div className="flex items-center gap-2.5">
        <BrandMark variant="bold" className="size-7 text-brand-cream" />
        <div className="leading-tight">
          <div className="text-[13px] font-medium text-foreground">Tafseer Clipper</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Subtitle studio
          </div>
        </div>
      </div>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <nav aria-label="Wizard steps" className="flex items-center gap-0.5">
        {STEPS.map((step) => {
          const active = currentStep === step;
          const done = stepCompletion(step, project, renderDoneForProject);
          const disabled = project === null && step !== 1;
          return (
            <Button
              key={step}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStep(step)}
              disabled={disabled}
              aria-current={active ? "step" : undefined}
              aria-label={`${step}. ${STEP_LABELS[step]}${done ? ", complete" : ""}`}
              className={cn(
                "h-auto gap-2 px-2.5 py-1.5 text-xs font-normal",
                active
                  ? "bg-accent text-foreground hover:bg-accent"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-[10px] tabular-nums",
                  active
                    ? "border-ring/50 bg-secondary text-foreground"
                    : done
                      ? "border-border bg-secondary/60 text-foreground"
                      : "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3" /> : step}
              </span>
              <span className="whitespace-nowrap">
                {step}. {STEP_LABELS[step]}
              </span>
            </Button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={SIDECAR_STATUS_LABEL[status]}
              onClick={() => void useSettingsStore.getState().refreshHealth()}
              className="h-auto gap-1.5 px-2 py-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              <SidecarStatusDot status={status} />
              <span className="hidden whitespace-nowrap lg:inline">
                {SIDECAR_STATUS_LABEL[status]}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 text-xs">
            {status === "online" && sidecar.health ? (
              <span className="flex flex-col gap-0.5">
                <span>Sidecar v{sidecar.health.version}</span>
                <span>{acceleration.label}</span>
                {acceleration.gpuName ? (
                  <span className="text-muted-foreground">Detected: {acceleration.gpuName}</span>
                ) : null}
                {acceleration.gpuDetected ? (
                  <span className="inline-flex items-baseline gap-1">
                    <span>GPU memory:</span>
                    <NumberFlow
                      value={sidecar.health.vram_mb}
                      suffix=" MB"
                      format={{ maximumFractionDigits: 0 }}
                    />
                  </span>
                ) : null}
              </span>
            ) : (
              (sidecar.error ?? `Click to ping the FastAPI sidecar on ${SIDECAR_URL}.`)
            )}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs font-normal text-muted-foreground"
              onClick={() => setRecentOpen(true)}
              disabled={recentCount === 0}
            >
              <History className="size-4" />
              Recent
              {recentCount > 0 ? (
                <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-secondary-foreground">
                  {recentCount}
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {recentCount > 0
              ? "Resume an auto-saved lecture"
              : "No auto-saved lectures yet"}
          </TooltipContent>
        </Tooltip>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 font-normal text-muted-foreground"
          onClick={toggleCommand}
        >
          <Command className="size-3.5" />
          <span className="text-[11px] tracking-wide">Ctrl K</span>
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open settings"
              onClick={() => openSettings()}
            >
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
