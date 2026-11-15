import { cn } from "cn";

import type { SidecarState } from "@/store/settingsStore";

/**
 * The one sidecar status indicator, shared by the header, Step 1 and Settings.
 * Uses the studio status tokens so chrome never falls back to off-palette
 * emerald/amber/red Tailwind colors (AGENTS.md §2).
 */
const STATUS_DOT: Record<SidecarState["status"], string> = {
  online: "bg-status-online",
  checking: "bg-status-warning animate-pulse",
  offline: "bg-status-danger",
  unknown: "bg-muted-foreground/50",
};

export const SIDECAR_STATUS_LABEL: Record<SidecarState["status"], string> = {
  online: "Engine ready",
  checking: "Checking…",
  offline: "Engine not responding",
  unknown: "Not checked yet",
};

export function SidecarStatusDot({
  status,
  className,
}: {
  status: SidecarState["status"];
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status], className)}
    />
  );
}
