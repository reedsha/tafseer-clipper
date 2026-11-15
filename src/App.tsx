import { useEffect } from "react";
import { Toaster, toast } from "sonner";

import { CommandMenu } from "@/components/CommandMenu";
import { RecentProjectsBar } from "@/components/RecentProjectsBar";
import { RecentProjectsDrawer } from "@/components/RecentProjectsDrawer";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { StartupGate } from "@/components/StartupGate";
import { StepperHeader } from "@/components/StepperHeader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { loadImportedFonts } from "@/lib/fonts";
import { openProjectFile } from "@/lib/projectFile";
import { startStartupUpdateCheck } from "@/lib/updater";
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
  const project = useProjectStore((state) => state.project);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const lastProjectId = useProjectStore((state) => state.lastProjectId);
  const setRecentOpen = useUiStore((state) => state.setRecentOpen);

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
              "Open Settings → Storage to install it. Nothing installs automatically.",
            action: {
              label: "View updates",
              onClick: () => useUiStore.getState().openSettings("storage"),
            },
            duration: 12_000,
          });
        },
      }),
    [],
  );

  async function handleResume(projectId: string) {
    const resumed = await useProjectStore.getState().resumeRecent(projectId);
    if (!resumed) {
      toast.error("Auto-save not found", {
        description:
          "No .tafseer snapshot was found for this lecture on disk or in local storage.",
      });
      return;
    }
    toast.success("Lecture resumed");
  }

  async function handleOpenFile() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      toast.success("Project opened", { description: opened.name });
    } catch (error) {
      toast.error("Could not open project", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {/* The app opens to the Recent Lectures bar above the stepper. */}
        {project === null && recentProjects.length > 0 ? (
          <RecentProjectsBar
            compact
            recentProjects={recentProjects}
            lastProjectId={lastProjectId}
            onResume={(id) => void handleResume(id)}
            onOpenFile={() => void handleOpenFile()}
            onViewAll={() => setRecentOpen(true)}
          />
        ) : null}
        <StepperHeader />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Workspace />
        </main>

        <SettingsDrawer />
        <CommandMenu />
        <RecentProjectsDrawer />
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
