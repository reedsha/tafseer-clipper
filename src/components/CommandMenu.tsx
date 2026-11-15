import { useEffect } from "react";
import { toast } from "sonner";
import {
  Activity,
  Captions,
  Cpu,
  Download,
  FilePlus2,
  FolderOpen,
  Gauge,
  History,
  Save,
  Scissors,
  SlidersHorizontal,
  Type,
  Upload,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { describeAcceleration } from "@/lib/acceleration";import { openProjectFile, saveProjectFile, suggestProjectFileName } from "@/lib/projectFile";
import { STEP_LABELS, type Resolution, type WizardStep } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore, type SettingsTab } from "@/store/uiStore";

const STEPS: WizardStep[] = [1, 2, 3, 4];

const SETTINGS_ENTRIES: { tab: SettingsTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { tab: "stage1", label: "Step 1 settings — upload, transcription & glossary", icon: Upload },
  { tab: "stage2", label: "Step 2 settings — clip discovery", icon: Scissors },
  { tab: "stage3", label: "Step 3 settings — subtitles, fonts & style", icon: Type },
  { tab: "stage4", label: "Step 4 settings — export defaults", icon: Download },
  { tab: "main", label: "Main settings — connections, hardware & storage", icon: SlidersHorizontal },
];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommandMenu() {
  const commandOpen = useUiStore((state) => state.commandOpen);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);
  const toggleCommand = useUiStore((state) => state.toggleCommand);
  const openSettings = useUiStore((state) => state.openSettings);
  const setRecentOpen = useUiStore((state) => state.setRecentOpen);

  const project = useProjectStore((state) => state.project);
  const recentCount = useProjectStore((state) => state.recentProjects.length);
  const createProject = useProjectStore((state) => state.createProject);
  const setStep = useProjectStore((state) => state.setStep);

  const editor = useSettingsStore((state) => state.editor);
  const whisper = useSettingsStore((state) => state.whisper);
  const updateEditor = useSettingsStore((state) => state.updateEditor);
  const updateWhisper = useSettingsStore((state) => state.updateWhisper);
  const refreshHealth = useSettingsStore((state) => state.refreshHealth);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommand();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleCommand]);

  const run = (action: () => void | Promise<void>) => {
    setCommandOpen(false);
    void action();
  };

  async function handleSaveProject() {
    const current = useProjectStore.getState().project;
    if (!current) {
      toast.error("No project open", { description: "Start a project from Step 1." });
      return;
    }
    try {
      const result = await saveProjectFile(current);
      if (result === "saved") {
        useProjectStore.getState().markSaved();
        toast.success("Project saved", {
          description: suggestProjectFileName(current),
        });
      }
    } catch (error) {
      toast.error("Could not save project", { description: describeError(error) });
    }
  }

  async function handleOpenProject() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      toast.success("Project opened", { description: opened.name });
    } catch (error) {
      toast.error("Could not open project", { description: describeError(error) });
    }
  }

  async function handleHealthCheck() {
    await refreshHealth();
    const sidecar = useSettingsStore.getState().sidecar;
    if (sidecar.status === "online" && sidecar.health) {
      const acceleration = describeAcceleration(sidecar.health);
      toast.success("Everything is running", {
        description: `Transcription: ${acceleration.transcription === "gpu" ? "GPU" : "CPU"}`,
      });
    } else {
      toast.error("The processing engine isn't responding", {
        description: sidecar.error ?? "Click Retry, or restart the app.",
      });
    }
  }

  // Settings → 4 · Export holds the defaults; the open project holds the live
  // value. Show the effective one so the palette can never lie about the
  // export that Step 3/4 will actually run.
  const resolution: Resolution = project?.export.resolution ?? editor.resolution;
  const useNvenc = project?.export.useNvenc ?? editor.useNvenc;
  const exportSrt = project?.export.exportSrt ?? editor.exportSrt;
  const aspectTarget = resolution === "1080x1920" ? "16:9" : "9:16";
  const nextResolution: Resolution = resolution === "1080x1920" ? "1920x1080" : "1080x1920";

  /** Persist a default *and* apply it to the open project (no sync-back). */
  const setExportDefault = (patch: {
    resolution?: Resolution;
    useNvenc?: boolean;
    exportSrt?: boolean;
  }) => {
    updateEditor(patch);
    useProjectStore.getState().applyExportDefaults(patch);
  };

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="Jump to a step, toggle a setting, or open a panel…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>

        <CommandGroup heading="Wizard">
          {STEPS.map((step) => (
            <CommandItem
              key={step}
              value={`step ${step} ${STEP_LABELS[step]}`}
              disabled={!project && step !== 1}
              onSelect={() => run(() => setStep(step))}
            >
              <span className="flex size-4 items-center justify-center rounded-full border border-border text-[10px] tabular-nums text-muted-foreground">
                {step}
              </span>
              {STEP_LABELS[step]}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Project">
          <CommandItem
            value="new project"
            onSelect={() =>
              run(() => {
                createProject();
              })
            }
          >
            <FilePlus2 />
            New project
          </CommandItem>
          <CommandItem
            value="save project tafseer"
            disabled={!project}
            onSelect={() => run(handleSaveProject)}
          >
            <Save />
            Save project (.tafseer)
          </CommandItem>
          <CommandItem value="open project tafseer" onSelect={() => run(handleOpenProject)}>
            <FolderOpen />
            Open project (.tafseer)
          </CommandItem>
          <CommandItem
            value="recent lectures resume"
            disabled={recentCount === 0}
            onSelect={() => run(() => setRecentOpen(true))}
          >
            <History />
            Recent lectures
            <CommandShortcut>{recentCount}</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Settings panels">
          {SETTINGS_ENTRIES.map(({ tab, label, icon: Icon }) => (
            <CommandItem
              key={tab}
              value={`settings ${tab} ${label}`}
              onSelect={() => run(() => openSettings(tab))}
            >
              <Icon />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Editor toggles">
          <CommandItem
            value={`aspect ratio ${aspectTarget}`}
            onSelect={() => run(() => setExportDefault({ resolution: nextResolution }))}
          >
            <Captions />
            Switch to {aspectTarget}
          </CommandItem>
          <CommandItem
            value="hardware encoding gpu acceleration nvenc"
            onSelect={() => run(() => setExportDefault({ useNvenc: !useNvenc }))}
          >
            <Cpu />
            Hardware encoding (GPU): {useNvenc ? "on" : "off"}
          </CommandItem>
          <CommandItem
            value="export srt subtitles"
            onSelect={() => run(() => setExportDefault({ exportSrt: !exportSrt }))}
          >
            <Download />
            Export .SRT: {exportSrt ? "on" : "off"}
          </CommandItem>
          <CommandItem
            value="whisper unload gpu memory vram"
            onSelect={() => run(() => updateWhisper({ autoUnload: !whisper.autoUnload }))}
          >
            <Gauge />
            Unload from GPU memory after transcription: {whisper.autoUnload ? "on" : "off"}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="App status">
          <CommandItem value="health sidecar status" onSelect={() => run(handleHealthCheck)}>
            <Activity />
            Check that everything is running
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
