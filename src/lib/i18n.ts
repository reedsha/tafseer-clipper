/**
 * Lightweight UI string dictionary (PR-5 groundwork).
 *
 * No i18n dependency is added: messages live in a typed object, the English
 * values are the single source of truth for the key union, and Thai entries can
 * arrive incrementally (untranslated keys fall back to English). This keeps the
 * English UI byte-identical while making the first-run surface translatable.
 */

import { useCallback } from "react";

import { useSettingsStore } from "@/store/settingsStore";

export type Locale = "en" | "th";

const EN = {
  "common.retry": "Retry",
  "common.restart": "Restart the app",
  "common.copyDiagnostics": "Copy diagnostics",
  "common.cancel": "Cancel",

  "step1.eyebrow": "Step 1 of 4",
  "step1.title": "Add your lecture",
  "step1.subtitle":
    "Drop a long-form Tafseer lecture. We'll transcribe the Thai–Arabic audio and find clip-worthy moments for you.",

  "step1.drop.dragging": "Release to load the lecture",
  "step1.drop.selected": "Lecture selected",
  "step1.drop.transcriptReady": "Transcript ready",
  "step1.drop.default": "Drop a lecture here",
  "step1.drop.hintDragging": "MP4, MOV or MKV",
  "step1.drop.hintSelected": "Ready for local transcription. Drop another file to replace it.",
  "step1.drop.hintTranscript":
    "The transcript is saved in this project. Continue to clip discovery, or replace the lecture.",
  "step1.drop.hintDefault":
    "MP4, MOV or MKV. Long-form Tafseer lectures are expected; audio stays on this machine.",
  "step1.browse": "Browse files",
  "step1.change": "Change",

  "step1.transcript.title": "Transcript ready",
  "step1.transcript.continue": "Continue to clip discovery",
  "step1.transcript.replace": "Replace lecture",

  "step1.busy.title": "Extracting audio and transcribing…",
  "step1.busy.description":
    "Arabic recitation is checked automatically. Transcription runs in the background. Long lectures can take a few minutes - the app stays responsive.",

  "step1.transcribe.title": "Transcribe the lecture",
  "step1.transcribe.description":
    "We pull out the audio and transcribe the Thai–Arabic speech. Your glossary is applied to the transcript afterwards.",
  "step1.transcribe.cta": "Transcribe lecture & find clips",
  "step1.transcribe.chooseFirst": "Choose a lecture file first.",
  "step1.transcribe.downloadNote":
    "The first transcription on this computer downloads about 1.5 GB of AI files.",

  "step1.brief.title": "Initial prompt (clip finding)",
  "step1.brief.description": "The standing instructions the AI follows when finding clips. Save your own as presets and switch between them.",
  "step1.brief.edit": "Edit initial prompt",

  "step1.guide.title": "Additional prompt (optional)",
  "step1.guide.description": "Extra instructions for this uploaded lecture only — ignored when empty.",
  "step1.guide.placeholder":
    "Focus on stories of the Prophets and practical rulings; ignore the first 10 minutes of audio checks.",

  "step1.ai.title": "AI setup",
  "step1.ai.description": "Choose where each step runs.",
  "step1.ai.change": "Change AI settings",
  "step1.ai.downloadNote":
    "The first transcription on this computer downloads about 1.5 GB of AI files.",

  "step1.offline.title": "The processing engine didn't start.",
  "step1.offline.description":
    "Transcription needs the engine. Retry, or restart the app if this keeps happening.",

  "step1.privacy":
    "Audio, transcripts and clips stay on this machine unless Cloud mode is selected.",

  "settings.language": "Language",
  "settings.language.hint": "Interface language",
} as const;

export type MessageKey = keyof typeof EN;

/** Thai strings; missing keys fall back to English until reviewed. */
const TH: Partial<Record<MessageKey, string>> = {
  "common.retry": "ลองอีกครั้ง",
  "common.restart": "รีสตาร์ทแอป",
  "common.copyDiagnostics": "คัดลอกข้อมูลวินิจฉัย",
  "common.cancel": "ยกเลิก",

  "step1.eyebrow": "ขั้นตอนที่ 1 จาก 4",
  "step1.title": "เพิ่มบทบรรยายของคุณ",
  "step1.subtitle":
    "ลากไฟล์บรรยายตัฟซีรแบบยาวมาวางที่นี่ เราจะถอดเสียงภาษาไทย–อาหรับและค้นหาช่วงที่น่าสนใจให้คุณ",

  "step1.drop.dragging": "ปล่อยเพื่อโหลดไฟล์บรรยาย",
  "step1.drop.selected": "เลือกไฟล์บรรยายแล้ว",
  "step1.drop.transcriptReady": "ข้อความถอดเสียงพร้อมแล้ว",
  "step1.drop.default": "วางไฟล์บรรยายที่นี่",
  "step1.drop.hintDragging": "MP4, MOV หรือ MKV",
  "step1.drop.hintSelected": "พร้อมถอดเสียงในเครื่องนี้ วางไฟล์อื่นเพื่อแทนที่",
  "step1.drop.hintTranscript":
    "ข้อความถอดเสียงถูกบันทึกในโปรเจกต์นี้แล้ว ไปค้นหาคลิปต่อ หรือแทนที่ไฟล์บรรยาย",
  "step1.drop.hintDefault":
    "MP4, MOV หรือ MKV รองรับไฟล์บรรยายตัฟซีรแบบยาว เสียงอยู่ในเครื่องนี้เท่านั้น",
  "step1.browse": "เลือกไฟล์",
  "step1.change": "เปลี่ยน",

  "step1.transcript.title": "ข้อความถอดเสียงพร้อมแล้ว",
  "step1.transcript.continue": "ไปค้นหาคลิปต่อ",
  "step1.transcript.replace": "แทนที่ไฟล์บรรยาย",

  "step1.busy.title": "กำลังแยกเสียงและถอดเสียง…",
  "step1.busy.description":
    "การถอดเสียงทำในเบื้องหลัง บรรยายยาวอาจใช้เวลาหลายนาที — แอปยังใช้งานได้ตามปกติ",

  "step1.transcribe.title": "ถอดเสียงบรรยาย",
  "step1.transcribe.description":
    "เราจะแยกเสียงและถอดเสียงภาษาไทย–อาหรับ จากนั้นนำอภิธานศัพท์ไปใช้กับข้อความ",
  "step1.transcribe.cta": "ถอดเสียงและค้นหาคลิป",
  "step1.transcribe.chooseFirst": "เลือกไฟล์บรรยายก่อน",
  "step1.transcribe.downloadNote":
    "การถอดเสียงครั้งแรกในเครื่องนี้จะดาวน์โหลดไฟล์ AI ประมาณ 1.5 GB",

  "step1.brief.title": "พรอมป์หลัก (สำหรับค้นหาคลิป)",
  "step1.brief.description": "คำสั่งหลักที่ AI ใช้เลือกคลิป บันทึกเป็นพรีเซ็ตแล้วสลับใช้ได้ตามต้องการ",
  "step1.brief.edit": "แก้พรอมป์หลัก",

  "step1.guide.title": "พรอมป์เพิ่มเติม (ไม่บังคับ)",
  "step1.guide.description": "คำสั่งเฉพาะสำหรับไฟล์บรรยายที่เปิดอยู่นี้เท่านั้น — เว้นว่างไว้ได้",
  "step1.guide.placeholder":
    "เน้นเรื่องราวของบรรดานบีและข้อปฏิบัติ ละเว้น 10 นาทีแรกที่เป็นการทดสอบเสียง",

  "step1.ai.title": "ตั้งค่า AI",
  "step1.ai.description": "เลือกเองว่าขั้นตอนใดทำงานที่ไหน",
  "step1.ai.change": "เปลี่ยนการตั้งค่า AI",
  "step1.ai.downloadNote":
    "การถอดเสียงครั้งแรกในเครื่องนี้จะดาวน์โหลดไฟล์ AI ประมาณ 1.5 GB",

  "step1.offline.title": "โปรแกรมประมวลผลไม่เริ่มทำงาน",
  "step1.offline.description":
    "การถอดเสียงต้องใช้โปรแกรมประมวลผล ลองอีกครั้ง หรือรีสตาร์ทแอปหากยังไม่หาย",

  "step1.privacy":
    "เสียง ข้อความถอดเสียง และคลิปจะอยู่ในเครื่องนี้ เว้นแต่เลือกโหมดคลาวด์",

  "settings.language": "ภาษา",
  "settings.language.hint": "ภาษาของหน้าจอ",
};

/** Translate a key with optional `{name}` interpolation. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = (locale === "th" ? TH[key] : undefined) ?? EN[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/** Locale-aware translator bound to the persisted UI language. */
export function useI18n() {
  const locale = useSettingsStore((state) => state.uiLanguage);
  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale],
  );
  return { locale, t };
}
