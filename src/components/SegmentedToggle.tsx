import { cn } from "cn";

import { Button } from "@/components/ui/button";

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * A two-or-more option switch built from shadcn/ui buttons. Used for the
 * engine routing on Step 1 and the output format on Step 4.
 */
export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T;
  options: SegmentedToggleOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "grid gap-1 rounded-md border border-border bg-muted/40 p-1",
        options.length === 2 ? "grid-cols-2" : "grid-cols-3",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Button
            key={option.value}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={active}
            disabled={disabled}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 w-full px-2 text-[11px] font-normal",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
