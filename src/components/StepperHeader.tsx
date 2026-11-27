import { L } from "@/lib/i18n";
import { Check, History, PanelLeftOpen, Settings, Settings2 } from "lucide-react";
import { cn } from "cn";

import { AiActivityLine } from "@/components/AiActivityLine";
import { TaskCenter } from "@/components/TaskCenter";
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
import { useAppVersion } from "@/lib/appVersion";
import { isSubtitleOnlyProject, STEP_LABELS, type WizardStep } from "@/lib/projectTypes";
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
      return !isSubtitleOnlyProject(project) && project.clips.some((clip) => clip.approved);
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
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const aiEntries = useAiActivityStore((state) => state.entries);

  const sidecar = useSettingsStore((state) => state.sidecar);
  /** Vendor-neutral acceleration state for the engine status tooltip. */
  const acceleration = describeAcceleration(sidecar.health);
  /** The installed app's version; the sidecar can lag behind after an update. */
  const appVersion = useAppVersion();

  const currentStep = project?.step ?? 1;
  const subtitleOnly = isSubtitleOnlyProject(project);
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

      {sidebarCollapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={L("Show sessions")}
              onClick={toggleSidebar}
              className="relative -ml-1 text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Show sessions (Ctrl+B)
          </TooltipContent>
        </Tooltip>
      ) : null}

      {/* No session yet: keep the chrome (engine status, AI activity, Settings)
          but hide the step tabs — there is nothing to step through until a
          session is opened or created. */}
      {project ? (
        <nav aria-label={L("Wizard steps")} className="relative flex h-full items-end gap-1.5">
          {STEPS.map((step) => {
            const active = currentStep === step;
            const done = stepCompletion(step, project, renderDoneForProject);
            const skipped = step === 2 && subtitleOnly;
            const disabled = project === null && step !== 1;
            const stepButton = (
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
                aria-label={`${step}. ${STEP_LABELS[step]}${
                  skipped ? ", skipped" : done ? ", complete" : ""
                }`}
                className={cn(
                  "h-auto gap-2.5 px-4 py-2 text-xs font-normal hover:bg-transparent",
                  active
                    ? "text-foreground hover:bg-transparent"
                    : "text-muted-foreground hover:text-foreground",
                  skipped && !active && "opacity-65",
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
                  {done ? <Check className="size-3" /> : skipped ? "—" : step}
                </span>
                <span className="whitespace-nowrap">
                  {step}. {STEP_LABELS[step]}
                </span>
                {skipped ? (
                  <span className="rounded border border-border/80 bg-muted/40 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                    {L("Skipped")}
                  </span>
                ) : null}
              </Button>
            );
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
                {skipped ? (
                  <Tooltip>
                    <TooltipTrigger asChild>{stepButton}</TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-64 text-xs">
                      {L("Skipped in Subtitles-only mode — click to switch to the full workflow")}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  stepButton
                )}
                {!skipped ? (
                  <>
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
                  </>
                ) : null}
              </div>
            );
          })}
        </nav>
      ) : null}

      <div className="relative ml-auto flex items-center gap-1.5">
        <TaskCenter />
        <Popover open={aiActivityOpen} onOpenChange={setAiActivityOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={L("Recent AI activity")}
              title={L("Recent AI activity")}
              className="text-muted-foreground"
            >
              <History className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2">
            <p className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
              {L("Recent AI activity")}
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
                {L("No AI runs yet this session.")}
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
                <span>Tafseer Clipper v{appVersion ?? sidecar.health.version}</span>
                {appVersion && sidecar.health.version !== appVersion ? (
                  <span className="text-muted-foreground">
                    Engine v{sidecar.health.version} (bundled engine)
                  </span>
                ) : null}
                <span>{acceleration.label}</span>
              </span>
            ) : (
              (sidecar.error ?? L("Click to check the processing engine again."))
            )}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={L("Open settings")}
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
