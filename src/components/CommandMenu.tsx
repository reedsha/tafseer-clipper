import { useEffect } from "react";
import NumberFlow from "@number-flow/react";
import { toast } from "sonner";
import {
  Activity,
  Bot,
  Captions,
  Cpu,
  Download,
  FilePlus2,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  Languages,
  Save,
  SlidersHorizontal,
  Type,
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
import { SIDECAR_URL } from "@/lib/api";
import { describeAcceleration } from "@/lib/acceleration";
import { openProjectFile, saveProjectFile, suggestProjectFileName } from "@/lib/projectFile";
import { STEP_LABELS, type Resolution, type WizardStep } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore, type SettingsTab } from "@/store/uiStore";

const STEPS: WizardStep[] = [1, 2, 3, 4];

const SETTINGS_ENTRIES: { tab: SettingsTab; label: string; icon: typeof Bot }[] = [
  { tab: "providers", label: "AI providers & models", icon: Bot },
  { tab: "fonts", label: "Fonts & dual-line style presets", icon: Type },
  { tab: "glossary", label: "Thai–Arabic glossary, Whisper & GPU", icon: Languages },
  { tab: "editor", label: "Editor & export defaults", icon: SlidersHorizontal },
  { tab: "storage", label: "Storage, auto-save & backup", icon: HardDrive },
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
      toast.success("Sidecar online", {
        description: (
          <span className="flex flex-col gap-0.5">
            <span className="inline-flex items-baseline gap-1">
              <span>v{sidecar.health.version} ·</span>
              <span>{acceleration.label}</span>
            </span>
            {acceleration.gpuName ? (
              <span className="text-muted-foreground">Detected: {acceleration.gpuName}</span>
            ) : null}
            {acceleration.gpuDetected ? (
              <span className="inline-flex items-baseline gap-1">
                <span>GPU memory:</span>
                <NumberFlow
                  value={sidecar.health.vram_mb}
                  suffix=" MB"
                  format={{ maximumFractionDigits: 0 }}
                />
              </span>
            ) : null}
          </span>
        ),
      });
    } else {
      toast.error("Sidecar offline", {
        description: sidecar.error ?? `Start backend.exe on ${SIDECAR_URL}.`,
      });
    }
  }

  // Settings → Editor holds the defaults; the open project holds the live
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
            Unload Whisper from GPU memory: {whisper.autoUnload ? "on" : "off"}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Sidecar">
          <CommandItem value="health sidecar status" onSelect={() => run(handleHealthCheck)}>
            <Activity />
            Check sidecar health
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
