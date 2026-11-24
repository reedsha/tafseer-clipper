import { L, useI18n } from "@/lib/i18n";
/**
 * Step 2 "Import clips from chat": paste the JSON a browser chat AI returned
 * for the exported brief, preview what will be imported (with every drop,
 * clamp and overlap flagged), and commit the rows as unapproved proposals
 * through the exact same `proposalToClip` path as in-app discovery.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import type { TimeRange } from "@/lib/api";
import { formatClock } from "@/lib/format";
import {
  parseImportedClips,
  proposalToClip,
  type ImportPreview,
  type ImportRow,
} from "@/lib/importClips";
import type { ProjectClip } from "@/lib/projectTypes";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";

export interface ImportClipsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function droppedLabel(item: ImportPreview["dropped"][number]): string {
  const parts: string[] = [];
  if (item.title) parts.push(`“${L(item.title)}”`);
  parts.push(L(item.reason));
  if (item.start !== undefined && item.end !== undefined) {
    parts.push(`${formatClock(item.start)}–${formatClock(item.end)}`);
  }
  return parts.join(" · ");
}

export function ImportClipsDialog({ open, onOpenChange }: ImportClipsDialogProps) {
  const { t } = useI18n();
  const project = useProjectStore((state) => state.project);
  const addClips = useProjectStore((state) => state.addClips);
  const editor = useSettingsStore((state) => state.editor);

  const approvedRanges = useMemo<TimeRange[]>(
    () =>
      (project?.clips ?? [])
        .filter((clip) => clip.approved)
        .map((clip) => ({ start: clip.start, end: clip.end })),
    [project?.clips],
  );

  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  // Close resets the paste so a second import starts clean.
  useEffect(() => {
    if (!open) {
      setText("");
      setPreview(null);
    }
  }, [open]);

  // Debounced parse: chat replies can be long, so don't re-parse every keystroke.
  useEffect(() => {
    if (!open || !text.trim()) {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPreview(
        parseImportedClips(text, {
          duration: project?.duration ?? 0,
          approvedRanges,
        }),
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, text, project?.duration, approvedRanges]);

  const rows = preview?.rows ?? [];
  const dropped = preview?.dropped ?? [];

  function handleImport() {
    if (!project || !preview || preview.rows.length === 0) return;
    const clips = preview.rows
      .map((row, index) =>
        proposalToClip(
          {
            start: row.start,
            end: row.end,
            title: row.title,
            rationale: row.rationale,
          },
          index,
          project.duration,
          editor.cutBufferSeconds,
          editor.autoPad,
        ),
      )
      .filter((clip): clip is ProjectClip => clip !== null);
    if (clips.length === 0) {
      toast.error(t("step2.import.failed"));
      return;
    }
    addClips(clips);
    toast.success(t("step2.import.added", { count: clips.length }));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("step2.import.title")}</DialogTitle>
          <DialogDescription>{t("step2.import.description")}</DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={t("step2.import.placeholder")}
          className="field-sizing-fixed max-h-48 resize-y font-mono text-xs leading-relaxed"
          aria-label={t("step2.import.title")}
        />

        {text.trim() && preview ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>
                {t("step2.import.summary", {
                  kept: preview.keptCount,
                  total: preview.totalCount,
                })}
              </span>
              {dropped.length > 0 ? (
                <span className="text-status-warning">
                  {t("step2.import.dropped", { count: dropped.length })}
                </span>
              ) : null}
              {preview.thinned ? (
                <span className="text-status-warning">
                  {t("step2.import.thinned", { kept: preview.keptCount })}
                </span>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("step2.import.noClips")}
              </p>
            ) : (
              <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {rows.map((row: ImportRow, index) => (
                  <li
                    key={`${row.start}-${row.end}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">
                        {L(row.title)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatClock(row.start)} – {formatClock(row.end)} ·{" "}
                        {formatClock(row.end - row.start)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {row.clamped ? (
                        <Badge variant="outline" className="text-[9px]">
                          {t("step2.import.clamped")}
                        </Badge>
                      ) : null}
                      {row.overlapsApproved ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] text-status-warning"
                        >
                          {t("step2.import.overlap")}
                        </Badge>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {dropped.length > 0 ? (
              <ul className="max-h-20 space-y-0.5 overflow-y-auto pr-1 text-[10px] text-muted-foreground">
                {dropped.map((item, index) => (
                  <li key={`${item.reason}-${index}`}>{droppedLabel(item)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={rows.length === 0} onClick={handleImport}>
            {t("step2.import.import", { count: rows.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
