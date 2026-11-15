import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { toast } from "sonner";
import { BookmarkPlus, RotateCcw, Save, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_DISCOVERY_SETTINGS } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";

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

  const activePreset =
    project?.promptPresetId != null
      ? (promptPresets.find((preset) => preset.id === project.promptPresetId) ?? null)
      : null;

  const [draft, setDraft] = useState(project?.basePrompt ?? "");
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(project?.basePrompt || activePreset?.prompt || "");
    setPresetName("");
  }, [open, project?.basePrompt, activePreset?.prompt]);

  function handleSave() {
    const trimmed = draft.trim();
    setBasePrompt(trimmed);
    if (!trimmed) {
      setPromptPreset(null);
      toast("Using the built-in defaults", {
        description: "You can add a clip brief any time from Step 1.",
      });
      onOpenChange(false);
      return;
    }
    if (activePreset && trimmed !== activePreset.prompt.trim()) {
      setPromptPreset(null);
      toast.success("Clip brief updated", {
        description: "Edited away from the preset — this project now uses a custom brief.",
      });
    } else {
      toast.success("Clip brief updated");
    }
    onOpenChange(false);
  }

  function handleSaveAsPreset() {
    const name = presetName.trim();
    const prompt = draft.trim();
    if (!name) {
      toast.error("Name the preset first", {
        description: "Give it a short name such as “Short reminders”.",
      });
      return;
    }
    if (!prompt) {
      toast.error("The brief is empty", {
        description: "Write the clip brief before saving a preset.",
      });
      return;
    }
    const discovery = project?.discovery ?? DEFAULT_DISCOVERY_SETTINGS;
    const id = addPromptPreset({
      name,
      description: "Saved from the clip brief drawer.",
      prompt,
      minDuration: discovery.minDuration,
      maxDuration: discovery.maxDuration,
      maxClips: discovery.maxClips,
    });
    setBasePrompt(prompt);
    setPromptPreset(id);
    toast.success("Prompt preset saved", { description: name });
    setPresetName("");
    onOpenChange(false);
  }

  function handleResetToPreset() {
    if (!activePreset) {
      setDraft("");
      toast("Draft cleared", { description: "Leave it empty to use the built-in defaults." });
      return;
    }
    setDraft(activePreset.prompt);
    toast("Preset text restored", { description: activePreset.name });
  }

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      direction="right"
      shouldScaleBackground={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px]" />
        <Drawer.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-background outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="space-y-0.5">
              <Drawer.Title className="text-sm font-medium text-foreground">
                Clip brief
              </Drawer.Title>
              <Drawer.Description className="text-xs text-muted-foreground">
                Tell the AI what kind of clips to find. We add the timing and formatting rules
                automatically.
              </Drawer.Description>
            </div>
            <Drawer.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close clip brief">
                <X className="size-4" />
              </Button>
            </Drawer.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {activePreset ? activePreset.name : "Custom / default"}
                </Badge>
                {activePreset ? (
                  <span className="text-[11px] text-muted-foreground">
                    {activePreset.minDuration}–{activePreset.maxDuration} s · up to{" "}
                    {activePreset.maxClips} clips
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Leave empty to use the built-in defaults.
                  </span>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="base-prompt" className="text-xs font-medium text-foreground/90">
                  What to look for
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
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleResetToPreset}>
                  <RotateCcw className="size-3.5" />
                  {activePreset ? "Reset to preset" : "Clear draft"}
                </Button>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-foreground/90">Save as a preset</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Presets live in Settings, travel with the portable backup, and can be picked
                    again from Step 1.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Preset name"
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
                    Save preset
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Drawer.Close asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </Drawer.Close>
            <Button size="sm" className="gap-1.5" onClick={handleSave}>
              <Save className="size-3.5" />
              Save prompt
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
