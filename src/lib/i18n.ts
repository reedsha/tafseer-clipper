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

/**
 * Selective translation for copy outside Step 1.
 *
 * Keyed by the English source string so a string can be added to the Thai side
 * incrementally: anything without a reviewed entry stays English. Deliberately
 * absent are format tokens, keyboard shortcuts, model/provider names, file
 * extensions and product names — translating those would confuse an editor.
 * `App` subscribes to `uiLanguage`, so every screen re-renders on a change.
 */
const TH_BY_EN: Record<string, string> = {
  // Common chrome
  Back: "ย้อนกลับ",
  Cancel: "ยกเลิก",
  Save: "บันทึก",
  Delete: "ลบ",
  Edit: "แก้ไข",
  Close: "ปิด",
  Minimize: "ย่อ",
  Maximize: "ขยายใหญ่สุด",
  "Restore down": "คืนขนาดเดิม",
  Retry: "ลองอีกครั้ง",
  Preview: "ดูตัวอย่าง",
  Settings: "การตั้งค่า",
  Approved: "อนุมัติแล้ว",
  Approve: "อนุมัติ",
  Model: "โมเดล",
  Modified: "ปรับเปลี่ยนแล้ว",
  Language: "ภาษา",
  English: "อังกฤษ",
  Play: "เล่น",
  Pause: "หยุดชั่วคราว",
  All: "ทั้งหมด",
  Review: "ตรวจสอบ",

  // Step 2 · Find Clips
  "Step 2 of 4 · Review & find more": "ขั้นตอนที่ 2 จาก 4 · ตรวจสอบและค้นหาเพิ่ม",
  "Find clips": "ค้นหาคลิป",
  "Proposed clips": "คลิปที่เสนอ",
  "No clips proposed yet": "ยังไม่มีคลิปที่เสนอ",
  "Change lecture": "เปลี่ยนไฟล์บรรยาย",
  "Clip finding failed": "การค้นหาคลิปล้มเหลว",
  "Re-transcribe": "ถอดเสียงใหม่",
  "Looking for more moments…": "กำลังค้นหาช่วงอื่นเพิ่มเติม…",
  "Reading the transcript for self-contained moments…":
    "กำลังอ่านข้อความถอดเสียงเพื่อหาช่วงที่สมบูรณ์…",
  "Search setup": "การตั้งค่าการค้นหา",
  "Set up, then Start": "ตั้งค่าแล้วเริ่มค้นหา",
  "Shortest (s)": "สั้นสุด (วินาที)",
  "Longest (s)": "ยาวสุด (วินาที)",
  "Re-find mode": "โหมดค้นหาใหม่",
  "Find more": "ค้นหาเพิ่ม",
  "Start over": "เริ่มใหม่",
  "Additional instructions for this search": "คำแนะนำเพิ่มเติมสำหรับการค้นหาครั้งนี้",
  "Start over with new clips": "เริ่มใหม่ด้วยคลิปใหม่",
  "Find more clips": "ค้นหาคลิปเพิ่ม",
  "Approve clips to keep them out of the next search.":
    "อนุมัติคลิปเพื่อไม่ให้รวมอยู่ในการค้นหาครั้งต่อไป",
  "No clip selected": "ยังไม่ได้เลือกคลิป",
  "Select a clip to preview": "เลือกคลิปเพื่อดูตัวอย่าง",
  "No video preview available": "ไม่มีตัวอย่างวิดีโอ",
  "Edge step size": "ขนาดขั้นการปรับขอบ",
  "Auto-pad cut buffer": "กันชนการตัดอัตโนมัติ",
  "Select a clip to preview and trim it.": "เลือกคลิปเพื่อดูตัวอย่างและปรับขอบ",
  "Continue to subtitles": "ไปยังซับไตเติล",
  "Back to upload": "กลับไปเพิ่มไฟล์",
  "No project open": "ไม่มีโปรเจกต์ที่เปิดอยู่",
  "Go to Step 1": "ไปขั้นตอนที่ 1",
  "Transcript missing": "ไม่มีข้อความถอดเสียง",
  "Clip removed": "ลบคลิปแล้ว",
  "Discovery cancelled": "ยกเลิกการค้นหาแล้ว",
  "No new clips": "ไม่มีคลิปใหม่",
  "Finding clips": "กำลังค้นหาคลิป",
  "Starting over with new clips": "กำลังเริ่มใหม่ด้วยคลิปใหม่",
  "More clips found": "พบคลิปเพิ่มเติม",
  "Clip proposals ready": "คลิปที่เสนอพร้อมแล้ว",

  // Step 3 · Subtitles
  "Step 3 of 4": "ขั้นตอนที่ 3 จาก 4",
  Subtitles: "ซับไตเติล",
  "Subtitle lines": "บรรทัดซับไตเติล",
  "To check": "รอตรวจ",
  "Add line": "เพิ่มบรรทัด",
  "Check Arabic": "ตรวจภาษาอาหรับ",
  "No Arabic lines": "ไม่มีบรรทัดภาษาอาหรับ",
  "No Thai line": "ไม่มีบรรทัดภาษาไทย",
  "No Arabic line": "ไม่มีบรรทัดภาษาอาหรับ",
  "No subtitle lines for this clip": "ไม่มีบรรทัดซับไตเติลสำหรับคลิปนี้",
  "Every line in this clip is checked": "ตรวจครบทุกบรรทัดในคลิปนี้แล้ว",
  "Switch to All to edit a line again.": "เปลี่ยนไปที่ “ทั้งหมด” เพื่อแก้ไขบรรทัดอีกครั้ง",
  "Rebuild lines": "สร้างบรรทัดใหม่",
  "Rebuild lines from transcript": "สร้างบรรทัดใหม่จากข้อความถอดเสียง",
  "Continue to export": "ไปยังการส่งออก",
  "Back to clip discovery": "กลับไปค้นหาคลิป",
  "Custom style": "สไตล์ที่กำหนดเอง",
  "Safe zone": "พื้นที่ปลอดภัย",
  "Previous line": "บรรทัดก่อนหน้า",
  "Next line": "บรรทัดถัดไป",
  Mute: "ปิดเสียง",
  Unmute: "เปิดเสียง",
  "Output preview": "ตัวอย่างผลลัพธ์",
  "Aspect ratio": "อัตราส่วนภาพ",
  "Framing mode": "โหมดจัดเฟรม",
  "Blur fill": "เติมแบบเบลอ",
  "Center crop": "ครอปกลาง",
  "No approved clips": "ไม่มีคลิปที่อนุมัติแล้ว",
  "Original Thai line restored": "คืนบรรทัดภาษาไทยเดิมแล้ว",
  "Arabic corrected": "แก้ภาษาอาหรับแล้ว",
  "Arabic checked": "ตรวจภาษาอาหรับแล้ว",
  "Arabic passages": "ข้อความภาษาอาหรับ",
  "No Arabic passages in this clip.": "ไม่มีข้อความภาษาอาหรับในคลิปนี้",
  "Restore Thai": "คืนภาษาไทย",

  // Step 4 · Export
  Export: "ส่งออก",
  "Export queue": "คิวส่งออก",
  "Nothing to export yet": "ยังไม่มีอะไรให้ส่งออก",
  "Step 4 of 4 · Batch render": "ขั้นตอนที่ 4 จาก 4 · เรนเดอร์เป็นชุด",
  "Rendering your clips…": "กำลังเรนเดอร์คลิปของคุณ…",
  "Cancel render": "ยกเลิกการเรนเดอร์",
  "Open folder": "เปิดโฟลเดอร์",
  "Copy path": "คัดลอกพาธ",
  "Back to subtitles": "กลับไปซับไตเติล",
  "Render again": "เรนเดอร์อีกครั้ง",
  "Filename template": "แม่แบบชื่อไฟล์",
  "Output folder": "โฟลเดอร์ผลลัพธ์",
  "Choose a folder": "เลือกโฟลเดอร์",
  "Browse…": "เรียกดู…",
  "Also export .SRT": "ส่งออก .SRT ด้วย",
  "Also export .SRT file": "ส่งออกไฟล์ .SRT ด้วย",
  "Hardware encoding (GPU)": "การเข้ารหัสแบบฮาร์ดแวร์ (GPU)",
  "Burned-in subtitle styles": "สไตล์ซับไตเติลที่ฝังในวิดีโอ",
  "Resulting names": "ชื่อไฟล์ที่ได้",
  "Windows-safe": "ปลอดภัยสำหรับ Windows",
  "GPU ready": "GPU พร้อม",
  "CPU fallback (slower)": "สำรอง CPU (ช้ากว่า)",
  Rendered: "เรนเดอร์แล้ว",
  Failed: "ล้มเหลว",
  Rendering: "กำลังเรนเดอร์",
  Cancelled: "ยกเลิกแล้ว",
  Queued: "อยู่ในคิว",
  "9:16 Vertical": "แนวตั้ง 9:16",
  "16:9 Widescreen": "จอกว้าง 16:9",

  // Configuration screens
  "Speech-to-text": "ถอดเสียง",
  "AI model": "โมเดล AI",
  "Cut buffer padding": "กันชนการตัด",
  "Style presets": "พรีเซ็ตสไตล์",
  "Custom fonts": "ฟอนต์ที่เพิ่มเอง",
  "Arabic verification": "การตรวจภาษาอาหรับ",
  "Add preset": "เพิ่มพรีเซ็ต",
  "New preset": "พรีเซ็ตใหม่",
  "New style preset": "พรีเซ็ตสไตล์ใหม่",
  "Edit style preset": "แก้ไขพรีเซ็ตสไตล์",
  "Preset name": "ชื่อพรีเซ็ต",
  "Save preset": "บันทึกพรีเซ็ต",
  "Save changes": "บันทึกการเปลี่ยนแปลง",
  "Delete preset?": "ลบพรีเซ็ต?",
  Controls: "การควบคุม",
  Typography: "การจัดหนังสือ",
  "Line breaking": "การตัดบรรทัด",
  "Font family": "ตระกูลฟอนต์",
  "Font size": "ขนาดฟอนต์",
  "Outline width": "ความกว้างขอบ",
  "Box opacity": "ความโปร่งใสของกล่อง",
  Bold: "ตัวหนา",
  Color: "สี",
  Presets: "พรีเซ็ต",
  "Show clip": "แสดงคลิป",
  Arabic: "อาหรับ",
  Thai: "ไทย",
  "Max characters per line": "จำนวนตัวอักษรสูงสุดต่อบรรทัด",
  "Lines per subtitle": "จำนวนบรรทัดต่อซับไตเตيل",
  Two: "สอง",
  One: "หนึ่ง",
  "Verification model": "โมเดลตรวจสอบ",
  Inherit: "สืบทอด",
  "Import .TTF / .OTF": "นำเข้า .TTF / .OTF",
  "Export defaults": "ค่าเริ่มต้นการส่งออก",
  "Target resolution": "ความละเอียดเป้าหมาย",
  "Style preset updated": "อัปเดตพรีเซ็ตสไตล์แล้ว",
  "Style preset saved": "บันทึกพรีเซ็ตสไตล์แล้ว",
  "Preset deleted": "ลบพรีเซ็ตแล้ว",
  "Custom font imported": "นำเข้าฟอนต์ที่เพิ่มเองแล้ว",
  "Font import failed": "นำเข้าฟอนต์ล้มเหลว",
  "e.g. Lecture gold": "เช่น สีทองสำหรับบทบรรยาย",
  "Edits apply live while you tune the style.": "การแก้ไขมีผลทันทีขณะปรับสไตล์",

  // Settings
  "AI connection": "การเชื่อมต่อ AI",
  "Fast judgments": "การตัดสินใจเร็ว",
  "GPU acceleration": "การเร่งด้วย GPU",
  "Storage & cache": "พื้นที่จัดเก็บและแคช",
  "Engine & diagnostics": "เครื่องมือประมวลผลและข้อมูลวินิจฉัย",
  "Backup & reset": "สำรองและรีเซ็ต",
  Updates: "การอัปเดต",
  "Keyboard shortcuts": "ทางลัดแป้นพิมพ์",
  "Back to app": "กลับไปแอป",
  Connected: "เชื่อมต่อแล้ว",
  "Test connection": "ทดสอบการเชื่อมต่อ",
  "Check again": "ตรวจอีกครั้ง",
  "Display language": "ภาษาที่แสดง",
  "Reset defaults": "รีเซ็ตค่าเริ่มต้น",
  "Reset all settings?": "รีเซ็ตการตั้งค่าทั้งหมด?",
  Reset: "รีเซ็ต",
  "Settings imported": "นำเข้าการตั้งค่าแล้ว",
  "Settings exported": "ส่งออกการตั้งค่าแล้ว",
  "Import failed": "นำเข้าล้มเหลว",
  "Diagnostics copied": "คัดลอกข้อมูลวินิจฉัยแล้ว",
  "Copy diagnostics": "คัดลอกข้อมูลวินิจฉัย",
  "App version": "เวอร์ชันแอป",
  "Engine version": "เวอร์ชันเครื่องมือประมวลผล",
  Acceleration: "การเร่งความเร็ว",
  Transcription: "การถอดเสียง",
  Encoding: "การเข้ารหัส",
  "GPU memory": "หน่วยความจำ GPU",
  Available: "พร้อมใช้งาน",
  Missing: "ไม่พบ",
  "Check for updates": "ตรวจหาการอัปเดต",
  "View all releases": "ดูการเปิดตัวทั้งหมด",
  "Install & restart": "ติดตั้งและรีสตาร์ท",
  "All shortcuts": "ทางลัดทั้งหมด",
  "Used in:": "ใช้ใน:",
  "Step 2 preview · Step 3 Output preview":
    "พรีวิวขั้นตอนที่ 2 · พรีวิวผลลัพธ์ขั้นตอนที่ 3",
  "Step 2 · waveform & trim": "ขั้นตอนที่ 2 · คลื่นเสียงและตัดต่อ",
  "Step 3 · Subtitle lines & Output preview":
    "ขั้นตอนที่ 3 · บรรทัดซับไตเติลและพรีวิวผลลัพธ์",
  "Step 3 · Subtitle lines": "ขั้นตอนที่ 3 · บรรทัดซับไตเติล",
  "Step 3 · Output preview (focus mode)":
    "ขั้นตอนที่ 3 · พรีวิวผลลัพธ์ (โหมดโฟกัส)",
  "Step 3 · Subtitle lines editor": "ขั้นตอนที่ 3 · ตัวแก้ไขบรรทัดซับไตเติล",
  "Any step · Command palette": "ทุกขั้นตอน · คำสั่งด่วน",
  "Download link copied": "คัดลอกลิงก์ดาวน์โหลดแล้ว",

  // Sessions & shell
  Today: "วันนี้",
  Yesterday: "เมื่อวาน",
  Earlier: "ก่อนหน้านี้",
  Sessions: "เซสชัน",
  "New session": "เซสชันใหม่",
  "Open .tafseer": "เปิด .tafseer",
  "Session name": "ชื่อเซสชัน",
  "Session removed": "ลบเซสชันแล้ว",
  "Remove this session?": "ลบเซสชันนี้?",
  "Keep session": "เก็บเซสชันไว้",
  "Remove session": "ลบเซสชัน",
  "Auto-save is on": "เปิดการบันทึกอัตโนมัติ",
  "Auto-save failed — changes are at risk": "บันทึกอัตโนมัติล้มเหลว — การเปลี่ยนแปลงอาจสูญหาย",
  "Rename (or double-click the row)": "เปลี่ยนชื่อ (หรือดับเบิลคลิกแถว)",
  "You're not in a session": "คุณยังไม่ได้อยู่ในเซสชัน",
  "Create new session": "สร้างเซสชันใหม่",
  "Open a session": "เปิดเซสชัน",
  "Open a .tafseer file…": "เปิดไฟล์ .tafseer…",
  "Wizard steps": "ขั้นตอนการทำงาน",
  "Recent AI activity": "กิจกรรม AI ล่าสุด",
  "No AI runs yet this session.": "ยังไม่มีการทำงานของ AI ในเซสชันนี้",
  "Open settings": "เปิดการตั้งค่า",
  "Engine ready": "เครื่องมือประมวลผลพร้อม",
  "Checking…": "กำลังตรวจ…",
  "Engine not responding": "เครื่องมือประมวลผลไม่ตอบสนอง",
  "Not checked yet": "ยังไม่ได้ตรวจ",
  "GPU memory:": "หน่วยความจำ GPU:",
  "Click to check the processing engine again.": "คลิกเพื่อตรวจเครื่องมือประมวลผลอีกครั้ง",
  "Running tasks": "งานที่กำลังทำงาน",
  "Rendering clips": "กำลังเรนเดอร์คลิป",
  "These keep running when you change steps or sessions.": "งานเหล่านี้ยังทำงานต่อเมื่อเปลี่ยนขั้นตอนหรือเซสชัน",
  "Stop tasks & quit": "หยุดงานและออก",
  "Keep running in tray": "ปล่อยให้ทำงานต่อในถาด",

  // Prompt drawer
  "Using the built-in defaults": "ใช้ค่าที่มีอยู่แล้ว",
  "Initial prompt updated": "อัปเดตพรอมป์หลักแล้ว",
  "Name the preset first": "ตั้งชื่อพรีเซ็ตก่อน",
  "The prompt is empty": "พรอมป์ยังว่างอยู่",
  "Prompt preset saved": "บันทึกพรีเซ็ตพรอมป์แล้ว",
  "Draft cleared": "ล้างร่างแล้ว",
  "Preset text restored": "คืนข้อความพรีเซ็ตแล้ว",
  "Initial prompt — clip finding": "พรอมป์หลัก — การค้นหาคลิป",
  "Close initial prompt": "ปิดพรอมป์หลัก",
  "Custom / default": "กำหนดเอง / ค่าเริ่มต้น",
  "What to look for": "สิ่งที่ต้องการค้นหา",
  "Reset to preset": "รีเซ็ตเป็นพรีเซ็ต",
  "Clear draft": "ล้างร่าง",
  "Save as a preset": "บันทึกเป็นพรีเซ็ต",
  "Save prompt": "บันทึกพรอมป์",
  "Leave empty to use the built-in defaults.": "เว้นว่างไว้เพื่อใช้ค่าที่มีอยู่แล้ว",

  // GPU pack
  "Could not enable GPU acceleration": "เปิดการเร่งด้วย GPU ไม่ได้",
  "GPU acceleration installed": "ติดตั้งการเร่งด้วย GPU แล้ว",
  "Restart the app to switch transcription and encoding to the GPU.":
    "รีสตาร์ทแอปเพื่อให้การถอดเสียงและการเข้ารหัสใช้ GPU",
  "Could not restart": "รีสตาร์ทไม่ได้",
  "Restart to use the GPU": "รีสตาร์ทเพื่อใช้ GPU",
  "Until then everything keeps running on the CPU.": "จนกว่าจะรีสตาร์ท ทุกอย่างยังทำงานบน CPU",
  "Enable GPU acceleration": "เปิดการเร่งด้วย GPU",
  "One download, no driver setup. CPU works meanwhile.": "ดาวน์โหลดครั้งเดียว ไม่ต้องตั้งค่าไดรเวอร์ ระหว่างนี้ CPU ยังใช้งานได้",
  "GPU acceleration enabled": "เปิดการเร่งด้วย GPU แล้ว",
  "Available in the installed desktop app": "ใช้ได้ในแอปเดสก์ท็อปที่ติดตั้งแล้ว",
  "CPU fallback automatic": "สำรอง CPU อัตโนมัติ",

  // App update toast
  "Open Settings → Updates to install it. Nothing installs automatically.":
    "เปิด การตั้งค่า → การอัปเดตเพื่อติดตั้ง ไม่มีการติดตั้งอัตโนมัติ",
  "View updates": "ดูการอัปเดต",

  // Stage configuration descriptions
  "Speech-to-text engine and model. Changes save automatically.":
    "เครื่องมือถอดเสียงและโมเดล การเปลี่ยนแปลงบันทึกอัตโนมัติ",
  "Clip finding engine, model and cut buffer. Changes save automatically.":
    "เครื่องมือค้นหาคลิป โมเดล และกันชนการตัด บันทึกอัตโนมัติ",
  "Fonts, Arabic and Thai typography, style presets, and Arabic verification. Changes save automatically.":
    "ฟอนต์ การจัดหนังสืออาหรับและไทย พรีเซ็ตสไตล์ และการตรวจภาษาอาหรับ บันทึกอัตโนมัติ",
  "File names, subtitles and export defaults. Changes save automatically.":
    "ชื่อไฟล์ ซับไตเติล และค่าเริ่มต้นการส่งออก บันทึกอัตโนมัติ",
  "One-click themes applied to the preview and the exported subtitles. Open the live style editor to create a new preset or edit an existing one.":
    "ธีมที่ใช้ได้ด้วยคลิกเดียวทั้งในตัวอย่างและซับไตเติลที่ส่งออก เปิดตัวแก้สไตล์เพื่อสร้างหรือแก้พรีเซ็ต",
  "Fonts are added to the app so exported subtitles always render Thai and Uthmani Arabic correctly.":
    "เพิ่มฟอนต์เพื่อให้ซับไตเติลที่ส่งออกแสดงภาษาไทยและอาหรับอุษมานีได้ถูกต้องเสมอ",
  "Checks the Uthmani Quranic/Hadith spelling of each Arabic line in Step 3. Used for Arabic spelling checks only and defaults to the Find Clips model.":
    "ตรวจการสะกดตามอุษมานีของข้อความอัลกุรอานและหะดีษในขั้นตอนที่ 3 ใช้เฉพาะการตรวจภาษาอาหรับ และใช้โมเดลเดียวกับการค้นหาคลิปตามค่าเริ่มต้น",
  "No custom fonts imported yet — system fonts are used until you import.":
    "ยังไม่มีฟอนต์ที่เพิ่มเอง ระบบจะใช้ฟอนต์ของเครื่องจนกว่าจะนำเข้า",
  "Uses the same engine and model chosen for clip finding. Change them in the Find Clips configuration.":
    "ใช้เครื่องมือและโมเดลเดียวกับการค้นหาคลิป เปลี่ยนได้ในการตั้งค่าค้นหาคลิป",
  "A sample line drawn on the export frame with the current typography. The frame never plays and never uses the lecture.":
    "บรรทัดตัวอย่างที่วาดบนเฟรมส่งออกด้วยการจัดหนังสือปัจจุบัน เฟรมนี้ไม่เล่นและไม่ใช้ไฟล์บรรยาย",
  "Sample line at export size. Drag a line or use ↑↓ to move it.":
    "บรรทัดตัวอย่างตามขนาดส่งออก ลากบรรทัดหรือใช้ ↑↓ เพื่อเลื่อน",
  "This removes the saved theme. Current typography stays as it is.":
    "จะลบธีมที่บันทึกไว้ การจัดหนังสือปัจจุบันยังคงอยู่",

  // Settings descriptions and field labels
  "One AI connection for clip finding, Arabic checking and cloud speech-to-text — cloud or on this computer.":
    "เชื่อมต่อ AI ครั้งเดียวสำหรับค้นหาคลิป ตรวจภาษาอาหรับ และถอดเสียงบนคลาวด์",
  "Small, fast models for yes/no and ranking decisions. They make each step quicker and fall back automatically when they are off.":
    "โมเดลขนาดเล็กที่ตัดสินใจเร็วสำหรับคำตอบใช่/ไม่ใช่และการจัดลำดับ ทำให้แต่ละขั้นตอนเร็วขึ้นและสำรองอัตโนมัติเมื่อปิด",
  "Optional hardware acceleration. Everything falls back to the CPU automatically.":
    "การเร่งด้วยฮาร์ดแวร์เป็นตัวเลือก และจะสำรองไปใช้ CPU อัตโนมัติ",
  "Auto-save, the project folder and the temporary disk cache.":
    "การบันทึกอัตโนมัติ โฟลเดอร์โปรเจกต์ และแคชชั่วคราว",
  "Live status of the processing engine, plus a copyable support bundle.":
    "สถานะปัจจุบันของเครื่องมือประมวลผล พร้อมชุดข้อมูล/support ที่คัดลอกได้",
  "Export or import every setting, or reset to defaults.":
    "ส่งออก นำเข้า หรือรีเซ็ตการตั้งค่าทั้งหมด",
  "Signed release updates for the installed desktop app.":
    "การอัปเดตที่เซ็นชื่อสำหรับแอปเดสก์ท็อปที่ติดตั้งแล้ว",
  "Keyboard shortcuts used across the studio.": "ทางลัดแป้นพิมพ์ที่ใช้ทั่วแอป",
  "Cloud (your AI account)": "คลาวด์ (บัญชี AI ของคุณ)",
  "An OpenAI-compatible connection. The server address and API key are entered here and nowhere else.":
    "การเชื่อมต่อที่เข้ากันได้กับ OpenAI กรอกที่อยู่เซิร์ฟเวอร์และคีย์ API ที่นี่เท่านั้น",
  "Server address": "ที่อยู่เซิร์ฟเวอร์",
  "API key": "คีย์ API",
  "Checks the address and key, then lists available models. No tokens used.":
    "ตรวจที่อยู่และคีย์ แล้วแสดงโมเดลที่ใช้ได้ ไม่มีการใช้โทเค็น",
  "Speech-to-text is checked when you transcribe.": "การถอดเสียงจะตรวจเมื่อเริ่มถอดเสียง",
  "Local (this computer, Ollama)": "ในเครื่อง (เครื่องนี้, Ollama)",
  "The offline engine used when a model selector is switched to “This computer”.":
    "เครื่องมือแบบออฟไลน์ที่ใช้เมื่อเลือก “เครื่องนี้” ในตัวเลือกโมเดล",
  "Ollama found": "พบ Ollama",
  "Ollama not found": "ไม่พบ Ollama",
  "Ollama server address": "ที่อยู่เซิร์ฟเวอร์ Ollama",
  "Install Ollama.": "ติดตั้ง Ollama",
  "Step 1 · finds spoken Arabic and where sentences end":
    "ขั้นตอนที่ 1 · หาข้อความอาหรับที่พูดและจุดจบของประโยค",
  "Step 2 · orders candidate moments before titles are written":
    "ขั้นตอนที่ 2 · จัดลำดับช่วงที่เป็นไปได้ก่อนตั้งชื่อ",
  "Step 3 · skips lines that are already correct":
    "ขั้นตอนที่ 3 · ข้ามบรรทัดที่ถูกต้องอยู่แล้ว",
  "Arabic triage": "การคัดกรองภาษาอาหรับ",
  "This computer": "เครื่องนี้",
  "Your AI account": "บัญชี AI ของคุณ",
  "Runs on this computer": "ทำงานบนเครื่องนี้",
  "Runs on your AI account": "ทำงานบนบัญชี AI ของคุณ",
  "Leaving a switch off keeps today's behavior exactly: the step uses its regular model, or its built-in rules.":
    "การปิดสวิตช์จะคงพฤติกรรมเดิมทุกประการ: ขั้นตอนใช้โมเดลปกติหรือกฎที่มีอยู่แล้ว",
  "Acceleration pack": "ชุดเร่งความเร็ว",
  "Auto-save & project folder": "การบันทึกอัตโนมัติและโฟลเดอร์โปรเจกต์",
  "Auto-save writes a .tafseer snapshot after every edit so a lecture can resume at Step 2 or 3.":
    "การบันทึกอัตโนมัติจะเขียนสแนปชอต .tafseer หลังทุกการแก้ไข เพื่อให้กลับมาทำต่อได้ในขั้นตอนที่ 2 หรือ 3",
  "Auto-save interval": "ช่วงเวลาบันทึกอัตโนมัติ",
  "Project folder": "โฟลเดอร์โปรเจกต์",
  "Used by native save dialogs": "ใช้โดยหน้าต่างบันทึกของระบบ",
  "Disk cache": "แคชในดิสก์",
  "Temporary audio extracts and preview files created by the app.":
    "ไฟล์เสียงและตัวอย่างที่แอปสร้างขึ้นชั่วคราว",
  "Cache size": "ขนาดแคช",
  "Work directory": "โฟลเดอร์ทำงาน",
  "Transcription can use the GPU.": "การถอดเสียงสามารถใช้ GPU ได้",
  "Engine & hardware": "เครื่องมือประมวลผลและฮาร์ดแวร์",
  "Read-only snapshot of the running app and engine.": "ภาพสถานะที่อ่านอย่างเดียวของแอปและเครื่องมือประมวลผล",
  "Diagnostics": "ข้อมูลวินิจฉัย",
  "Copy a support bundle with versions, paths and the last engine health snapshot.":
    "คัดลอกชุดข้อมูลสนับสนุนพร้อมเวอร์ชัน พาธ และสถานะล่าสุดของเครื่องมือประมวลผล",
  "Portable settings backup": "สำรองการตั้งค่าแบบพกพา",
  "Export or import API keys, glossaries, prompts and style presets. Font files themselves are not included — only the list of imported faces.":
    "ส่งออกหรือนำเข้าคีย์ API อภิธานศัพท์ พรอมป์ และพรีเซ็ตสไตล์ ไม่รวมไฟล์ฟอนต์ — รวมเฉพาะรายชื่อฟอนต์ที่นำเข้า",
  "Export settings (.json)": "ส่งออกการตั้งค่า (.json)",
  "Import settings (.json)": "นำเข้าการตั้งค่า (.json)",
  "The exported file contains API keys in plain text. Store it somewhere private and never share it.":
    "ไฟล์ที่ส่งออกมีคีย์ API เป็นข้อความธรรมดา เก็บไว้ในที่ส่วนตัวและอย่าแชร์",
  "Restores the default dark studio configuration and clears every API key, imported font reference, glossary pair, style preset and prompt preset. Export a backup first if you need any of them.":
    "คืนค่าการตั้งค่าเริ่มต้นและลบคีย์ API ฟอนต์ที่นำเข้า อภิธานศัพท์ พรีเซ็ตสไตล์ และพรีเซ็ตพรอมป์ทั้งหมด สำรองก่อนหากต้องการใช้ต่อ",
  "Release channel": "ช่องทางการเปิดตัว",
  "Download the latest release for the installed desktop app. Nothing installs automatically.":
    "ดาวน์โหลดเวอร์ชันล่าสุดสำหรับแอปเดสก์ท็อปที่ติดตั้ง ไม่มีการติดตั้งอัตโนมัติ",
  "Shown after an update check": "แสดงหลังตรวจหาการอัปเดต",
  "Desktop app only": "เฉพาะแอปเดสก์ท็อป",
  "Used across the studio.": "ใช้ทั่วทั้งแอป",
  "You are up to date": "คุณใช้เวอร์ชันล่าสุดแล้ว",
  "No update is staged": "ไม่มีการอัปเดตที่รอติดตั้ง",
  "Update failed": "การอัปเดตล้มเหลว",
  "Update installed": "ติดตั้งการอัปเดตแล้ว",
  "Restart failed": "รีสตาร์ทไม่ได้",

  // Landing and sessions
  "A session keeps one lecture's transcript, clips and subtitles together. Open a saved session to pick up where you left off, or create a new one to start with a lecture.":
    "เซสชันเก็บข้อความถอดเสียง คลิป และซับไตเติลของบทบรรยายหนึ่งไว้ด้วยกัน เปิดเซสชันที่บันทึกไว้เพื่อทำต่อ หรือสร้างใหม่เพื่อเริ่มด้วยบทบรรยาย",
  "Start with a fresh lecture. You'll transcribe the audio and find clips in Step 1.":
    "เริ่มด้วยบทบรรยายใหม่ คุณจะถอดเสียงและค้นหาคลิปในขั้นตอนที่ 1",
  "Resume a recent session or open a saved .tafseer file.":
    "กลับไปทำต่อในเซสชันล่าสุด หรือเปิดไฟล์ .tafseer ที่บันทึกไว้",
  "No recent sessions yet. Your sessions appear here automatically as you work.":
    "ยังไม่มีเซสชันล่าสุด เซสชันจะปรากฏที่นี่โดยอัตโนมัติขณะคุณทำงาน",
  "Transcripts and clips stay on this machine. Settings are available from the Ctrl + K menu.":
    "ข้อความถอดเสียงและคลิปอยู่ในเครื่องนี้ การตั้งค่าเปิดได้จากเมนู Ctrl + K",
  "No sessions yet. Choose “Create new session” on the start screen to begin — every lecture is auto-saved here so you can resume without re-transcribing.":
    "ยังไม่มีเซสชัน เลือก “สร้างเซสชันใหม่” ในหน้าเริ่มต้น — ทุกบทบรรยายจะบันทึกอัตโนมัติที่นี่เพื่อให้ทำต่อโดยไม่ต้องถอดเสียงใหม่",

  // Configuration page titles and option labels
  "Upload configuration": "การตั้งค่าการเพิ่มบทบรรยาย",
  "Find Clips configuration": "การตั้งค่าการค้นหาคลิป",
  "Subtitles configuration": "การตั้งค่าซับไตเติล",
  "Export configuration": "การตั้งค่าการส่งออก",
  "AI service": "บริการ AI",
  "AI service (cloud)": "บริการ AI (คลาวด์)",
  "From your AI connection": "จากการเชื่อมต่อ AI ของคุณ",
  "Installed Ollama models": "โมเดล Ollama ที่ติดตั้งไว้",
  "Auto-detect": "ตรวจจับอัตโนมัติ",
  "Thai (with Arabic)": "ไทย (พร้อมอาหรับ)",
  "Display language of the app.": "ภาษาที่แสดงของแอป",
  "Interface text is translated where it reads naturally; technical names and shortcuts stay in English.":
    "แปลข้อความที่อ่านเข้าใจง่ายเป็นภาษาไทย ชื่อทางเทคนิคและทางลัดยังคงเป็นภาษาอังกฤษ",
};

let activeLocale: Locale = useSettingsStore.getState().uiLanguage;
useSettingsStore.subscribe((state) => {
  activeLocale = state.uiLanguage;
});

/** Translate a user-visible English string when a Thai entry exists. */
export function L(english: string): string {
  return activeLocale === "th" ? (TH_BY_EN[english] ?? english) : english;
}
