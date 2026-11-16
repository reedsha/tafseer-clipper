import NumberFlow from "@number-flow/react";
import { Check, History, Settings, Settings2 } from "lucide-react";
import { cn } from "cn";

import { AiActivityLine } from "@/components/AiActivityLine";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SIDECAR_STATUS_LABEL,
  SidecarStatusDot,
} from "@/components/SidecarStatusDot";
import { describeAcceleration } from "@/lib/acceleration";
import { STEP_LABELS, type WizardStep } from "@/lib/projectTypes";
import { useAiActivityStore } from "@/store/aiActivityStore";
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

  const openConfig = useUiStore((state) => state.openConfig);
  const closeConfig = useUiStore((state) => state.closeConfig);
  const openSettings = useUiStore((state) => state.openSettings);
  const aiActivityOpen = useUiStore((state) => state.aiActivityOpen);
  const setAiActivityOpen = useUiStore((state) => state.setAiActivityOpen);
  const aiEntries = useAiActivityStore((state) => state.entries);

  const sidecar = useSettingsStore((state) => state.sidecar);
  /** Vendor-neutral acceleration state for the engine status tooltip. */
  const acceleration = describeAcceleration(sidecar.health);

  const currentStep = project?.step ?? 1;
  const renderJob = useRenderStore((state) => state.job);
  const renderDoneForProject =
    renderJob.projectId !== null &&
    renderJob.projectId === project?.id &&
    renderJob.status === "done";

  return (
    /* Chrome-style stage tabs: the header's bottom rule is an overlay line the
       active tab covers, so the selected stage reads as connected to the
       content below it (the inactive ones stay recessed). */
    <header className="relative flex h-14 shrink-0 items-center gap-3 bg-card/30 px-4">
      {/* The rule the active stage tab sits on (and visually erases). */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border" />

      <nav aria-label="Wizard steps" className="relative flex h-full items-end gap-1.5">
        {STEPS.map((step) => {
          const active = currentStep === step;
          const done = stepCompletion(step, project, renderDoneForProject);
          const disabled = project === null && step !== 1;
          return (
            <div
              key={step}
              className={cn(
                "flex items-center gap-0.5 rounded-t-lg border border-b-0 px-1",
                active
                  ? "border-border bg-background"
                  : "border-transparent hover:bg-accent/30",
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Clicking a stage always leaves configuration mode and
                  // shows that stage.
                  closeConfig();
                  setStep(step);
                }}
                disabled={disabled}
                aria-current={active ? "step" : undefined}
                aria-label={`${step}. ${STEP_LABELS[step]}${done ? ", complete" : ""}`}
                className={cn(
                  "h-auto gap-2.5 px-4 py-2 text-xs font-normal hover:bg-transparent",
                  active
                    ? "text-foreground hover:bg-transparent"
                    : "text-muted-foreground hover:text-foreground",
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
              <Separator orientation="vertical" className={cn("h-4", !active && "opacity-50")} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Step ${step} configuration`}
                    onClick={() => openConfig(step)}
                    className={cn(
                      "mr-1 hover:text-foreground",
                      active ? "text-muted-foreground" : "text-muted-foreground/70",
                    )}
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {STEP_LABELS[step]} configuration
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </nav>

      <div className="relative ml-auto flex items-center gap-1.5">
        <Popover open={aiActivityOpen} onOpenChange={setAiActivityOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Recent AI activity"
              title="Recent AI activity"
              className="text-muted-foreground"
            >
              <History className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2">
            <p className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
              Recent AI activity
            </p>
            {aiEntries.length ? (
              <div className="space-y-1">
                {aiEntries.slice(0, 6).map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-md border border-border bg-card/40 px-2 py-1.5"
                  >
                    <AiActivityLine entry={entry} detailed />
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">
                No AI runs yet this session.
              </p>
            )}
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={SIDECAR_STATUS_LABEL[sidecar.status]}
              onClick={() => void useSettingsStore.getState().refreshHealth()}
              className="h-auto gap-1.5 px-2 py-1 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              <SidecarStatusDot status={sidecar.status} />
              <span className="hidden whitespace-nowrap lg:inline">
                {SIDECAR_STATUS_LABEL[sidecar.status]}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 text-xs">
            {sidecar.status === "online" && sidecar.health ? (
              <span className="flex flex-col gap-0.5">
                <span>Engine v{sidecar.health.version}</span>
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
              (sidecar.error ?? "Click to check the processing engine again.")
            )}
          </TooltipContent>
        </Tooltip>

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
