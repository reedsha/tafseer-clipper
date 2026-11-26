/**
 * Custom window title bar (desktop builds only).
 *
 * The native Windows title bar paints itself with the OS accent colour and can
 * never inherit the studio CSS tokens, so `tauri.conf.json` declares the main
 * window undecorated and this component draws the chrome in the renderer.
 * Every colour comes from the dark studio token system (AGENTS.md §2) — no OS
 * accent, no bright surface, no second standout element.
 *
 * The left side is a Tauri drag region (double-click toggles maximize); the
 * right side uses the built-in window commands, which emit the same
 * `closeRequested` event the shell already uses for the graceful close dialog.
 */

import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { L } from "@/lib/i18n";
import { isDesktopRuntime } from "@/lib/projectFile";
import { cn } from "cn";

/** `null` in the plain-browser build, where the browser owns the window chrome. */
const appWindow = isDesktopRuntime() ? getCurrentWindow() : null;

interface TitleBarButtonProps {
  label: string;
  onClick: () => void;
  close?: boolean;
  children: ReactNode;
}

function TitleBarButton({ label, onClick, close, children }: TitleBarButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "h-full w-11 rounded-none px-0 py-0 text-muted-foreground",
        "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-0",
        close &&
          "hover:bg-destructive hover:text-destructive-foreground dark:hover:bg-destructive focus-visible:bg-destructive focus-visible:text-destructive-foreground",
      )}
    >
      {children}
    </Button>
  );
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = appWindow;
    if (!win) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        if (await win.isMaximized()) {
          if (active) setMaximized(true);
        }
        unlisten = await win.onResized(() => {
          void win.isMaximized().then((value) => {
            if (active) setMaximized(value);
          });
        });
      } catch {
        /* API unavailable during teardown — keep the last known icon. */
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  if (!appWindow) return null;

  return (
    <div
      // Above Settings (z-40), dialogs and the command palette (z-50) so the
      // window controls stay reachable while any overlay is open.
      className="relative z-[60] flex h-[var(--titlebar-height)] shrink-0 select-none items-stretch border-b border-border bg-card/30"
    >
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-2 px-3"
      >
        <BrandMark className="pointer-events-none size-4 text-brand-cream" />
        <span className="pointer-events-none truncate text-[11px] font-medium tracking-wide text-foreground/80">
          Tafseer Clipper
        </span>
      </div>

      <div data-tauri-drag-region="false" className="flex items-stretch">
        <TitleBarButton
          label={L("Minimize")}
          onClick={() =>
            void appWindow.minimize().catch((error) => {
              console.error("TitleBar minimize failed", error);
            })
          }
        >
          <Minus className="size-3.5" />
        </TitleBarButton>
        <TitleBarButton
          label={maximized ? L("Restore down") : L("Maximize")}
          onClick={() =>
            void appWindow.toggleMaximize().catch((error) => {
              console.error("TitleBar toggleMaximize failed", error);
            })
          }
        >
          {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
        </TitleBarButton>
        <TitleBarButton
          label={L("Close")}
          onClick={() =>
            void appWindow.close().catch((error) => {
              console.error("TitleBar close failed", error);
            })
          }
          close
        >
          <X className="size-3.5" />
        </TitleBarButton>
      </div>
    </div>
  );
}
