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
  KeyRound,
  Keyboard,
  Languages,
  Save,
  Settings2,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { describeAcceleration } from "@/lib/acceleration";
import { openProjectFile, saveProjectFile, suggestProjectFileName } from "@/lib/projectFile";
import { STEP_LABELS, type Resolution, type WizardStep } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore, type SettingsSection } from "@/store/uiStore";

const STEPS: WizardStep[] = [1, 2, 3, 4];

const SETTINGS_ENTRIES: { section: SettingsSection; label: string; icon: typeof Cpu }[] = [
  { section: "connection", label: "Settings — AI connection (cloud & local)", icon: KeyRound },
  { section: "gpu", label: "Settings — GPU acceleration", icon: Cpu },
  { section: "storage", label: "Settings — storage & cache", icon: FolderOpen },
  { section: "engine", label: "Settings — engine & diagnostics", icon: Activity },
  { section: "language", label: "Settings — language", icon: Languages },
  { section: "backup", label: "Settings — backup & reset", icon: Save },
  { section: "updates", label: "Settings — updates", icon: Download },
  { section: "shortcuts", label: "Settings — keyboard shortcuts", icon: Keyboard },
];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CommandMenu() {
  const commandOpen = useUiStore((state) => state.commandOpen);
  const setCommandOpen = useUiStore((state) => state.setCommandOpen);
  const toggleCommand = useUiStore((state) => state.toggleCommand);
  const openSettings = useUiStore((state) => state.openSettings);
  const openConfig = useUiStore((state) => state.openConfig);
  const setAiActivityOpen = useUiStore((state) => state.setAiActivityOpen);

  const project = useProjectStore((state) => state.project);
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
      toast.error("No session open", { description: "Start a session from Step 1." });
      return;
    }
    try {
      const result = await saveProjectFile(current);
      if (result === "saved") {
        useProjectStore.getState().markSaved();
        toast.success("Session saved", {
          description: suggestProjectFileName(current),
        });
      }
    } catch (error) {
      toast.error("Could not save session", { description: describeError(error) });
    }
  }

  async function handleOpenProject() {
    try {
      const opened = await openProjectFile();
      if (!opened) return;
      useProjectStore.getState().openProject(opened);
      toast.success("Session opened", { description: opened.name });
    } catch (error) {
      toast.error("Could not open session", { description: describeError(error) });
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
            value="new session project"
            onSelect={() =>
              run(() => {
                createProject();
              })
            }
          >
            <FilePlus2 />
            New session
          </CommandItem>
          <CommandItem
            value="save session project tafseer"
            disabled={!project}
            onSelect={() => run(handleSaveProject)}
          >
            <Save />
            Save session (.tafseer)
          </CommandItem>
          <CommandItem
            value="open session project tafseer"
            onSelect={() => run(handleOpenProject)}
          >
            <FolderOpen />
            Open session (.tafseer)
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Settings">
          {SETTINGS_ENTRIES.map(({ section, label, icon: Icon }) => (
            <CommandItem
              key={section}
              value={`settings ${section} ${label}`}
              onSelect={() => run(() => openSettings(section))}
            >
              <Icon />
              {label}
            </CommandItem>
          ))}
          {STEPS.map((step) => (
            <CommandItem
              key={`config-${step}`}
              value={`configuration ${step} ${STEP_LABELS[step]}`}
              disabled={!project && step !== 1}
              onSelect={() => run(() => openConfig(step))}
            >
              <Settings2 />
              {STEP_LABELS[step]} configuration
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
          <CommandItem
            value="ai activity recent runs model task"
            onSelect={() => run(() => setAiActivityOpen(true))}
          >
            <History />
            Show recent AI activity
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
