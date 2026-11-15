import { cn } from "cn";

import { Badge } from "@/components/ui/badge";
import type { HardwareTier } from "@/lib/api";
import { fitLabel } from "@/lib/providers";

const DOT: Record<HardwareTier, string> = {
  high: "bg-status-online",
  medium: "bg-status-warning",
  low: "bg-status-danger",
};

/**
 * Honest capability verdict for local AI on this machine. Never names
 * hardware or states VRAM requirements (AGENTS.md §3) — only a tier.
 */
export function FitBadge({
  tier,
  className,
}: {
  tier: HardwareTier | undefined;
  className?: string;
}) {
  if (!tier) return null;
  return (
    <Badge variant="outline" className={cn("gap-1.5 text-[10px]", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tier])} />
      {fitLabel(tier)}
    </Badge>
  );
}
