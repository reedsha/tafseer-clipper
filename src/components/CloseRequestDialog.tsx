import { L } from "@/lib/i18n";
/**
 * Desktop close confirmation.
 *
 * `src-tauri/src/lib.rs` intercepts `WindowEvent::CloseRequested` only when the
 * renderer has reported active jobs, then emits `app://close-requested`. This
 * dialog is the single place the user decides what happens to that work:
 * stop it, or keep the app alive in the system tray while the sidecar finishes.
 * A crash or Task Manager kill never reaches this path, so it still terminates.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isDesktopRuntime } from "@/lib/projectFile";
import { useJobStore } from "@/store/jobStore";
import { useRenderStore } from "@/store/renderStore";

function runningCount(): number {
  const jobs = useJobStore.getState().jobs.filter((job) => job.status === "running").length;
  const render = useRenderStore.getState().job.status === "running" ? 1 : 0;
  return jobs + render;
}

export function CloseRequestDialog() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let unlisten: (() => void) | undefined;
    void listen<number>("app://close-requested", (event) => {
      setCount(typeof event.payload === "number" ? event.payload : runningCount());
      setOpen(true);
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  async function stopAndQuit() {
    useJobStore.getState().cancelAll();
    if (useRenderStore.getState().job.status === "running") {
      useRenderStore.getState().cancelRender();
    }
    setOpen(false);
    try {
      await invoke("quit_app");
    } catch {
      /* The window is closing anyway; nothing useful to report. */
    }
  }

  async function keepRunning() {
    setOpen(false);
    try {
      await invoke("minimize_to_tray");
    } catch {
      /* Leave the window open rather than silently losing the choice. */
      setOpen(true);
    }
  }

  const plural = count === 1 ? "" : "s";
  const them = count === 1 ? "it" : "them";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {count} task{plural} still running
          </DialogTitle>
          <DialogDescription>
            Closing Tafseer Clipper now will stop {them}. You can keep {them} running in
            the system tray; the work continues in the background until it finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {L("Cancel")}
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={() => void stopAndQuit()}>
              Stop tasks &amp; quit
            </Button>
            <Button onClick={() => void keepRunning()}>{L("Keep running in tray")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
