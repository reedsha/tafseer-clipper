import type { WizardStep } from "@/lib/projectTypes";
import { create } from "zustand";

/** Sections of the full-page Settings screen (left sidebar entries). */
export type SettingsSection =
  | "connection"
  | "gpu"
  | "storage"
  | "engine"
  | "language"
  | "backup"
  | "updates"
  | "shortcuts";

interface UiState {
  commandOpen: boolean;
  /** Full-page Settings screen (sidebar + content pane). */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Full-page "<Stage> configuration" screen replacing the wizard step. */
  configStep: WizardStep | null;
  /** Recent AI activity popover in the header. */
  aiActivityOpen: boolean;

  setCommandOpen: (open: boolean) => void;
  setAiActivityOpen: (open: boolean) => void;
  toggleCommand: () => void;
  openSettings: (section?: SettingsSection) => void;
  setSettingsOpen: (open: boolean) => void;
  openConfig: (step: WizardStep) => void;
  closeConfig: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  commandOpen: false,
  settingsOpen: false,
  settingsSection: "connection",
  configStep: null,
  aiActivityOpen: false,

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setAiActivityOpen: (aiActivityOpen) => set({ aiActivityOpen }),
  toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),
  openSettings: (section) =>
    set((state) => ({
      settingsOpen: true,
      settingsSection: section ?? state.settingsSection,
    })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openConfig: (configStep) => set({ configStep }),
  closeConfig: () => set({ configStep: null }),
}));
