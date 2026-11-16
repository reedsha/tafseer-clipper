import { useEffect } from "react";
import { Toaster, toast } from "sonner";

import { CommandMenu } from "@/components/CommandMenu";
import { SettingsScreen } from "@/components/config/SettingsScreen";
import { StageConfig } from "@/components/config/StageConfig";
import { SessionsSidebar } from "@/components/SessionsSidebar";
import { StartupGate } from "@/components/StartupGate";
import { StepperHeader } from "@/components/StepperHeader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadImportedFonts } from "@/lib/fonts";
import { startStartupUpdateCheck } from "@/lib/updater";
import { cn } from "cn";
import { Step1Ingest } from "@/steps/Step1Ingest";
import { Step2Discovery } from "@/steps/Step2Discovery";
import { Step3Subtitles } from "@/steps/Step3Subtitles";
import { Step4Export } from "@/steps/Step4Export";
import { startProjectAutosave, useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";

function Workspace() {
  const step = useProjectStore((state) => state.project?.step ?? 1);
  switch (step) {
    case 2:
      return <Step2Discovery />;
    case 3:
      return <Step3Subtitles />;
    case 4:
      return <Step4Export />;
    default:
      return <Step1Ingest />;
  }
}

export default function App() {
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const configStep = useUiStore((state) => state.configStep);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => {
      // Background poll: keep the current status LED instead of flashing
      // "checking" every 15 s.
      void useSettingsStore.getState().refreshHealth({ background: true });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => startProjectAutosave(), []);

  /* Imported .ttf/.otf files must be visible to the WebView preview so its
     typeface matches the burned-in .ass (asset protocol, no-op in a browser). */
  useEffect(() => {
    void loadImportedFonts(useSettingsStore.getState().importedFonts);
  }, []);

  /* One silent update check per desktop session (Tauri only, after the app has
     settled). The toast is informational; install controls live in Settings. */
  useEffect(
    () =>
      startStartupUpdateCheck({
        onAvailable: (result) => {
          toast.info(`Tafseer Clipper ${result.version} is available`, {
            description:
              "Open Settings → Updates to install it. Nothing installs automatically.",
            action: {
              label: "View updates",
              onClick: () => useUiStore.getState().openSettings("updates"),
            },
            duration: 12_000,
          });
        },
      }),
    [],
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <SessionsSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <StepperHeader />
          <main className="min-h-0 flex-1 overflow-hidden">
            {/* A stage configuration replaces only the content area: the recent
                bar and stepper stay in place and the stages stay clickable. The
                step stays mounted underneath (hidden) so anything running — a
                transcription, a render — is never interrupted. */}
            <div className={cn("h-full", configStep !== null && "hidden")}>
              <Workspace />
            </div>
            {configStep !== null ? <StageConfig step={configStep} /> : null}
          </main>
        </div>

        {/* Settings is the one screen that takes over the whole window. */}
        {settingsOpen ? <SettingsScreen /> : null}
        <CommandMenu />
        <StartupGate />

        <Toaster
          theme="dark"
          position="bottom-right"
          closeButton
          toastOptions={{
            classNames: {
              toast: "border border-border bg-card text-card-foreground shadow-lg",
              description: "text-muted-foreground",
              actionButton: "bg-secondary text-secondary-foreground",
              cancelButton: "bg-muted text-muted-foreground",
            },
          }}
        />
      </div>
    </TooltipProvider>
  );
}
