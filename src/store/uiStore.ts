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

const SIDEBAR_COLLAPSED_KEY = "tafseer.sidebar.collapsed.v1";

function loadSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* Ignore unavailable localStorage. */
  }
}

interface UiState {
  commandOpen: boolean;
  /** Full-page Settings screen (sidebar + content pane). */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Full-page "<Stage> configuration" screen replacing the wizard step. */
  configStep: WizardStep | null;
  /** Recent AI activity popover in the header. */
  aiActivityOpen: boolean;
  /** Whether the left Sessions sidebar is collapsed. */
  sidebarCollapsed: boolean;

  setCommandOpen: (open: boolean) => void;
  setAiActivityOpen: (open: boolean) => void;
  toggleCommand: () => void;
  openSettings: (section?: SettingsSection) => void;
  setSettingsOpen: (open: boolean) => void;
  openConfig: (step: WizardStep) => void;
  closeConfig: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  commandOpen: false,
  settingsOpen: false,
  settingsSection: "connection",
  configStep: null,
  aiActivityOpen: false,
  sidebarCollapsed: loadSidebarCollapsed(),

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
  setSidebarCollapsed: (sidebarCollapsed) => {
    saveSidebarCollapsed(sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      saveSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    }),
}));
