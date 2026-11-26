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

function split(seconds: number, fractionDigits: 0 | 1 | 2) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const scale = 10 ** fractionDigits;
  // Round at the displayed precision before splitting so values like 59.999 s
  // or 0.0499 s carry cleanly and never truncate downward.
  const total = Math.round(safe * scale);
  const fraction = scale > 1 ? total % scale : 0;
  const whole = Math.floor(total / scale);
  return {
    hours: Math.floor(whole / 3600),
    minutes: Math.floor((whole % 3600) / 60),
    seconds: whole % 60,
    fraction,
  };
}

/**
 * Animated mm:ss / h:mm:ss timestamp. Every numeric transition goes through
 * NumberFlow, per the design contract.
 */
export function TimeFlow({ value, tenths = false, hundredths = false, className }: TimeFlowProps) {
  const fractionDigits: 0 | 1 | 2 = hundredths ? 2 : tenths ? 1 : 0;
  const precision = hundredths ? "hundredths" : tenths ? "tenths" : false;
  const parts = split(value, fractionDigits);
  const showHours = parts.hours > 0;

  return (
    <span
      className={cn("inline-flex items-baseline tabular-nums", className)}
      aria-label={formatClock(value, precision)}
    >
      {showHours ? (
        <>
          <NumberFlow
            value={parts.hours}
            locales="en-US"
            format={{ maximumFractionDigits: 0 }}
            className="shrink-0 tabular-nums"
          />
          <span className="px-0.5 text-muted-foreground/70">:</span>
        </>
      ) : null}
      <NumberFlow
        value={parts.minutes}
        locales="en-US"
        format={{
          minimumIntegerDigits: showHours ? 2 : 1,
          maximumFractionDigits: 0,
        }}
        className="shrink-0 tabular-nums"
      />
      <span className="px-0.5 text-muted-foreground/70">:</span>
      <NumberFlow
        value={parts.seconds}
        locales="en-US"
        format={{ minimumIntegerDigits: 2, maximumFractionDigits: 0 }}
        className="shrink-0 tabular-nums"
      />
      {fractionDigits > 0 ? (
        <>
          <span className="text-muted-foreground/70">.</span>
          <NumberFlow
            value={parts.fraction}
            locales="en-US"
            format={{ minimumIntegerDigits: fractionDigits, maximumFractionDigits: 0 }}
            className="shrink-0 tabular-nums"
          />
        </>
      ) : null}
    </span>
  );
}
