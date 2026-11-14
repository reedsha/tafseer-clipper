import NumberFlow from "@number-flow/react";
import { cn } from "cn";

import { formatClock } from "@/lib/format";

interface TimeFlowProps {
  /** Absolute seconds in the source lecture. */
  value: number;
  /** Show a tenths digit (trim controls, waveform labels). */
  tenths?: boolean;
  /** Show a hundredths digit (subtitle cue boundaries). Wins over `tenths`. */
  hundredths?: boolean;
  className?: string;
}

function split(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return {
    hours: Math.floor(safe / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: Math.floor(safe % 60),
    tenths: Math.floor((safe * 10) % 10),
    hundredths: Math.floor((safe * 100) % 100),
  };
}

/**
 * Animated mm:ss / h:mm:ss timestamp. Every numeric transition goes through
 * NumberFlow, per the design contract.
 */
export function TimeFlow({ value, tenths = false, hundredths = false, className }: TimeFlowProps) {
  const parts = split(value);
  const showHours = parts.hours > 0;
  const fractionDigits = hundredths ? 2 : tenths ? 1 : 0;
  const fraction = hundredths ? parts.hundredths : parts.tenths;

  return (
    <span
      className={cn("inline-flex items-baseline tabular-nums", className)}
      aria-label={formatClock(value, fractionDigits > 0)}
    >
      {showHours ? (
        <>
          <NumberFlow
            value={parts.hours}
            format={{ maximumFractionDigits: 0 }}
            className="shrink-0 tabular-nums"
          />
          <span className="px-0.5 text-muted-foreground/70">:</span>
        </>
      ) : null}
      <NumberFlow
        value={parts.minutes}
        format={{
          minimumIntegerDigits: showHours ? 2 : 1,
          maximumFractionDigits: 0,
        }}
        className="shrink-0 tabular-nums"
      />
      <span className="px-0.5 text-muted-foreground/70">:</span>
      <NumberFlow
        value={parts.seconds}
        format={{ minimumIntegerDigits: 2, maximumFractionDigits: 0 }}
        className="shrink-0 tabular-nums"
      />
      {fractionDigits > 0 ? (
        <>
          <span className="text-muted-foreground/70">.</span>
          <NumberFlow
            value={fraction}
            format={{ minimumIntegerDigits: fractionDigits, maximumFractionDigits: 0 }}
            className="shrink-0 tabular-nums"
          />
        </>
      ) : null}
    </span>
  );
}
