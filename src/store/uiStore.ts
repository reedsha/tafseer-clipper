import { create } from "zustand";

export type SettingsTab = "stage1" | "stage2" | "stage3" | "stage4" | "main";

interface UiState {
  commandOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  recentOpen: boolean;

  setCommandOpen: (open: boolean) => void;
  toggleCommand: () => void;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (tab?: SettingsTab) => void;
  setRecentOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  commandOpen: false,
  settingsOpen: false,
  settingsTab: "main",
  recentOpen: false,

  setCommandOpen: (commandOpen) => set({ commandOpen }),
  toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openSettings: (tab = "main") => set({ settingsOpen: true, settingsTab: tab }),
  setRecentOpen: (recentOpen) => set({ recentOpen }),
}));
