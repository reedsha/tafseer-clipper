import { L } from "@/lib/i18n";
import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import { Cpu, Download, Loader2, RotateCw, Sparkles } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  accelerationFraction,
  accelerationProgressLabel,
  canEnableGpu,
  downloadAccelerationPack,
  ensureAccelerationStatusLoaded,
  humanizeAccelerationReason,
  isGpuEncodingAvailable,
  useAccelerationPack,
  type AccelerationSummary,
} from "@/lib/acceleration";
import { isTauriRuntime } from "@/lib/media";
import { relaunchApp } from "@/lib/updater";

/**
 * Vendor-neutral acceleration UI, shared by Settings → GPU acceleration and the
 * Step 1 transcription hint so both always show the same state and action.
 *
 * Copy rules (AGENTS.md §3): GPU/CPU state only, no product lines, no VRAM
 * requirements, and the CPU fallback is always stated. Detected hardware names
 * appear only inside a diagnostics tooltip.
 */

const DOT_CLASS: Record<AccelerationSummary["state"], string> = {
  ready: "bg-status-online",
  "gpu-detected-needs-runtime": "bg-status-warning",
  "cpu-only": "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/30",
};

/** Compact status line: dot + label, with the detected adapter in a tooltip. */
export function GpuStatusLine({
  summary,
  className,
}: {
  summary: AccelerationSummary;
  className?: string;
}) {
  const line = (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[summary.state])} />
      <span className="text-[11px] text-foreground/90">{summary.label}</span>
    </span>
  );

  if (!summary.gpuName && !summary.cudaRuntime) return line;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{line}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-xs">
        <span className="block">Detected: {summary.gpuName ?? "GPU"}</span>
        <span className="block text-muted-foreground">
          Acceleration runtime: {summary.cudaRuntime ? "installed" : "not installed"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Download + restart actions for the acceleration pack. */
function GpuPackAction({ summary }: { summary: AccelerationSummary }) {
  const pack = useAccelerationPack();
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // The pack lives in the desktop shell; a browser tab can never install it, so
  // the action is hidden rather than offered and then failing on click.
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    if (desktopRuntime) void ensureAccelerationStatusLoaded();
  }, [desktopRuntime]);

  const downloading = busy || pack.phase === "downloading";
  const installed = pack.status?.installed === true || pack.phase === "installed";
  const needsRestart = installed && summary.state !== "ready" && summary.gpuDetected;
  const fraction = accelerationFraction(pack);
  const percent = fraction === null ? null : Math.round(fraction * 100);

  async function handleEnable() {
    if (downloading) return;
    setBusy(true);
    const result = await downloadAccelerationPack();
    setBusy(false);
    if ("error" in result) {
      toast.error(L("Could not enable GPU acceleration"), { description: result.error });
      return;
    }
    toast.success(L("GPU acceleration installed"), {
      description: L("Restart the app to switch transcription and encoding to the GPU."),
    });
  }

  async function handleRestart() {
    if (restarting) return;
    setRestarting(true);
    try {
      await relaunchApp();
    } catch (error) {
      toast.error(L("Could not restart"), {
        description: error instanceof Error ? error.message : String(error),
      });
      setRestarting(false);
    }
  }

  if (!desktopRuntime) return null;

  if (needsRestart) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void handleRestart()}
          disabled={restarting}
        >
          {restarting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          {L("Restart to use the GPU")}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {L("Until then everything keeps running on the CPU.")}
        </span>
      </div>
    );
  }

  if (canEnableGpu(summary)) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void handleEnable()}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {L("Enable GPU acceleration")}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {L("One download, no driver setup. CPU works meanwhile.")}
          </span>
        </div>

        {downloading ? (
          <div className="space-y-1">
            <Progress value={percent ?? undefined} aria-label="GPU acceleration download" />
            <p className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
              <NumberFlow
                value={percent ?? 0}
                suffix="%"
                format={{ maximumFractionDigits: 0 }}
              />
              <span aria-hidden>·</span>
              <span>{accelerationProgressLabel(pack)}</span>
              {pack.progress && pack.progress.file_count > 0 ? (
                <span className="text-muted-foreground/70">
                  · file {pack.progress.file_index + 1} of {pack.progress.file_count}
                </span>
              ) : null}
            </p>
          </div>
        ) : null}

        {pack.phase === "unsupported" ? (
          <p className="text-[11px] text-muted-foreground">{pack.message}</p>
        ) : null}
      </div>
    );
  }

  if (installed) {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-[11px] text-status-online">
          <Sparkles className="size-3" />
          {L("GPU acceleration enabled")}
        </p>
        {pack.status ? (
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {pack.status.version ? `Pack ${pack.status.version} · ` : ""}
            <NumberFlow
              value={Math.round((pack.status.size_bytes / 1024 / 1024) * 10) / 10}
              suffix=" MB"
              format={{ maximumFractionDigits: 1 }}
            />
            <span className="sr-only"> installed</span>
          </p>
        ) : null}
      </div>
    );
  }

  return null;
}

/**
 * Full acceleration panel: status, explanation, CPU fallback and the one-click
 * GPU pack action. Used in Settings → Main.
 */
export function GpuAccelerationPanel({ summary }: { summary: AccelerationSummary }) {
  const pack = useAccelerationPack();
  const reason = humanizeAccelerationReason(summary.reason);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GpuStatusLine summary={summary} />
        {summary.state === "ready" ? (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            <Cpu className="size-3" />
            {L("CPU fallback automatic")}
          </span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">{summary.description}</p>
      {reason ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">{reason}</p>
      ) : null}

      <GpuPackAction summary={summary} />

      {!isTauriRuntime() || pack.phase === "unsupported" ? (
        <p className="text-[11px] text-muted-foreground">{L("Available in the installed desktop app")}</p>
      ) : null}
    </div>
  );
}

/**
 * Compact inline callout for Step 1: only renders when the user can act
 * (GPU detected but runtime missing) or when the CPU fallback is worth stating.
 */
export function GpuInlineHint({ summary }: { summary: AccelerationSummary }) {
  const pack = useAccelerationPack();

  useEffect(() => {
    void ensureAccelerationStatusLoaded();
  }, []);

  if (summary.state === "ready") {
    return (
      <p className="flex items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
        <GpuStatusLine summary={summary} />
        <span aria-hidden>·</span>
        <span>Transcription can use the GPU.</span>
      </p>
    );
  }

  if (canEnableGpu(summary)) {
    const installed = pack.status?.installed === true || pack.phase === "installed";
    return (
      <div className="space-y-1.5 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-2">
        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-status-warning">
          <Cpu className="mt-0.5 size-3 shrink-0" />
          <span className="flex-1">
            A GPU is available but its acceleration runtime is not installed. CPU transcription works
            meanwhile (slower).
          </span>
        </p>
        {installed ? null : <GpuPackAction summary={summary} />}
      </div>
    );
  }

  return (
    <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
      <Cpu className="mt-0.5 size-3 shrink-0" />
      <span>
        {summary.state === "cpu-only"
          ? "CPU transcription — slower, always available. Enable GPU acceleration in Settings → Main if your machine supports it."
          : "Local transcription runs on this machine. CPU transcription is always available."}
      </span>
    </p>
  );
}

/** Human copy for the Step 4 availability line. */
export function encodingAvailabilityText(summary: AccelerationSummary): string {
  if (isGpuEncodingAvailable(summary)) return L("GPU ready");
  return "CPU fallback (slower)";
}
