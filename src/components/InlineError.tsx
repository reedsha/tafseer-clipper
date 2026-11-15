import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "cn";

/**
 * One plain line ("what happened") plus at most one primary action.
 * Toasts stay reserved for confirmations; problems that need a decision render
 * here so they cannot disappear before the editor acts on them.
 */
export function InlineError({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">{title}</p>
        {children ? <p className="break-words">{children}</p> : null}
        {action ? <div className="flex flex-wrap gap-1.5 pt-0.5">{action}</div> : null}
      </div>
    </div>
  );
}
