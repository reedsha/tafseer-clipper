import { L } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { toast } from "sonner";
import { BookmarkPlus, RotateCcw, Save, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { cn } from "cn";

interface PromptDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Vaul slide-over for the editable Base System Prompt. Saved prompts become
 * app-level preset entries, so they travel with the portable settings backup.
 */
export function PromptDrawer({ open, onOpenChange }: PromptDrawerProps) {
  const project = useProjectStore((state) => state.project);
  const setBasePrompt = useProjectStore((state) => state.setBasePrompt);
  const setPromptPreset = useProjectStore((state) => state.setPromptPreset);

  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const addPromptPreset = useSettingsStore((state) => state.addPromptPreset);
  const deletePromptPreset = useSettingsStore((state) => state.deletePromptPreset);

  const [draft, setDraft] = useState(project?.basePrompt ?? "");
  const [presetName, setPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    project?.promptPresetId ?? null,
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const selectedPreset =
    selectedPresetId != null
      ? (promptPresets.find((preset) => preset.id === selectedPresetId) ?? null)
      : null;
  const pendingDeletePreset =
    pendingDeleteId != null
      ? (promptPresets.find((preset) => preset.id === pendingDeleteId) ?? null)
      : null;

  useEffect(() => {
    if (!open) return;
    // Read the presets once at open time (not in the dependency list) so
    // deleting a row never resets the text the editor is currently typing.
    const presets = useSettingsStore.getState().promptPresets;
    const appliedId = useProjectStore.getState().project?.promptPresetId ?? null;
    const applied = appliedId
      ? (presets.find((preset) => preset.id === appliedId) ?? null)
      : null;
    setDraft(project?.basePrompt || applied?.prompt || "");
    setSelectedPresetId(appliedId);
    setPresetName("");
    setPendingDeleteId(null);
  }, [open, project?.basePrompt, project?.promptPresetId]);

  function handleSave() {
    const trimmed = draft.trim();
    setBasePrompt(trimmed);
    if (!trimmed) {
      setPromptPreset(null);
      toast(L("Using the built-in defaults"), {
        description: "You can add an initial prompt any time from Step 1.",
      });
      onOpenChange(false);
      return;
    }
    if (selectedPreset && trimmed === selectedPreset.prompt.trim()) {
      setPromptPreset(selectedPreset.id);
      toast.success(L("Initial prompt updated"), { description: selectedPreset.name });
    } else if (project?.promptPresetId != null) {
      setPromptPreset(null);
      toast.success(L("Initial prompt updated"), {
        description: "Edited away from the preset — this project now uses a custom prompt.",
      });
    } else {
      toast.success(L("Initial prompt updated"));
    }
    onOpenChange(false);
  }

  function handleSaveAsPreset() {
    const name = presetName.trim();
    const prompt = draft.trim();
    if (!name) {
      toast.error(L("Name the preset first"), {
        description: "Give it a short name such as “Short reminders”.",
      });
      return;
    }
    if (!prompt) {
      toast.error(L("The prompt is empty"), {
        description: "Write the initial prompt before saving a preset.",
      });
      return;
    }
    const id = addPromptPreset({
      name,
      description: "Saved from the initial-prompt drawer.",
      prompt,
    });
    setBasePrompt(prompt);
    setPromptPreset(id);
    toast.success(L("Prompt preset saved"), { description: name });
    setPresetName("");
    onOpenChange(false);
  }

  function handleResetToPreset() {
    if (!selectedPreset) {
      setDraft("");
      toast(L("Draft cleared"), { description: "Leave it empty to use the built-in defaults." });
      return;
    }
    setDraft(selectedPreset.prompt);
    toast(L("Preset text restored"), { description: selectedPreset.name });
  }

  function handleSelectPreset(presetId: string) {
    const preset = promptPresets.find((item) => item.id === presetId);
    if (!preset) return;
    setDraft(preset.prompt);
    setSelectedPresetId(preset.id);
  }

  function handleConfirmDelete() {
    const id = pendingDeleteId;
    if (!id) return;
    const preset = promptPresets.find((item) => item.id === id) ?? null;
    deletePromptPreset(id);
    if (project?.promptPresetId === id) setPromptPreset(null);
    if (selectedPresetId === id) setSelectedPresetId(null);
    setPendingDeleteId(null);
    toast.success(L("Preset deleted"), { description: preset?.name });
  }

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <>
      <Drawer.Root
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        shouldScaleBackground={false}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-x-0 bottom-0 top-[var(--titlebar-height)] z-50 bg-black/60 backdrop-blur-[1px]" />
          <Drawer.Content className="fixed bottom-0 top-[var(--titlebar-height)] right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-background outline-none">
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div className="space-y-0.5">
                <Drawer.Title className="text-sm font-medium text-foreground">
                  {L("Initial prompt — clip finding")}
                </Drawer.Title>
                <Drawer.Description className="text-xs text-muted-foreground">
                  The standing instructions the AI follows when finding clips. It decides how many
                  clips the lecture holds and how long each one needs.
                </Drawer.Description>
              </div>
              <Drawer.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label={L("Close initial prompt")}>
                  <X className="size-4" />
                </Button>
              </Drawer.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{selectedPreset ? selectedPreset.name : L("Custom / default")}</Badge>
                  {selectedPreset ? (
                    <span className="text-[11px] text-muted-foreground">
                      {L("Loaded from a saved preset.")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {L("Leave empty to use the built-in defaults.")}
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="base-prompt" className="text-xs font-medium text-foreground/90">
                    {L("What to look for")}
                  </Label>
                  <Textarea
                    id="base-prompt"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="You are a senior Islamic-studies video editor cutting Thai Tafseer lectures into short social clips…"
                    spellCheck={false}
                    className="min-h-[300px] resize-y text-xs leading-relaxed"
                  />
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{words} words</span>
                    <span>{draft.length} characters</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleResetToPreset}
                  >
                    <RotateCcw className="size-3.5" />
                    {selectedPreset ? L("Reset to preset") : L("Clear draft")}
                  </Button>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-foreground/90">{L("Save as a preset")}</p>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Presets travel with the portable settings backup and can be picked again from
                      this list.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={presetName}
                      onChange={(event) => setPresetName(event.target.value)}
                      placeholder={L("Preset name")}
                      aria-label="New prompt preset name"
                      className="h-8 text-xs"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleSaveAsPreset();
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      onClick={handleSaveAsPreset}
                    >
                      <BookmarkPlus className="size-3.5" />
                      {L("Save preset")}
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground/90">{L("Saved presets")}</p>
                    <Badge variant="outline" className="px-1.5 text-[10px]">
                      {promptPresets.length}
                    </Badge>
                  </div>

                  {promptPresets.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                      {L("No saved presets yet — save one above.")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                      {promptPresets.map((preset) => {
                        const isApplied = project?.promptPresetId === preset.id;
                        const isSelected = selectedPresetId === preset.id;
                        return (
                          <li
                            key={preset.id}
                            className={cn(
                              "flex items-stretch",
                              isSelected && "bg-accent/30",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => handleSelectPreset(preset.id)}
                              aria-pressed={isSelected}
                              className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-accent/20 focus-visible:bg-accent/30 focus-visible:outline-none"
                            >
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-foreground">
                                  {preset.name}
                                </span>
                                {isApplied ? (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 px-1 py-0 text-[9px] uppercase tracking-wide"
                                  >
                                    {L("Applied")}
                                  </Badge>
                                ) : null}
                              </span>
                              <span className="line-clamp-1 text-[10px] leading-relaxed text-muted-foreground">
                                {preset.prompt}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDeleteId(preset.id)}
                              aria-label={`${L("Delete preset")} ${preset.name}`}
                              className="flex w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:bg-destructive/15 focus-visible:text-destructive focus-visible:outline-none"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {L(
                      "Picking a preset loads it into the editor above; Save prompt applies it to this project.",
                    )}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Drawer.Close asChild>
                <Button variant="ghost" size="sm">
                  {L("Cancel")}
                </Button>
              </Drawer.Close>
              <Button size="sm" className="gap-1.5" onClick={handleSave}>
                <Save className="size-3.5" />
                {L("Save prompt")}
              </Button>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null);
        }}
      >
        <DialogContent className="z-[55]">
          <DialogHeader>
            <DialogTitle>{L("Delete this preset?")}</DialogTitle>
            <DialogDescription>
              {L(
                "The saved prompt is removed from the list. This project's current prompt stays as it is.",
              )}
              {pendingDeletePreset ? ` — ${pendingDeletePreset.name}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>
              {L("Cancel")}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirmDelete}>
              {L("Delete preset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
