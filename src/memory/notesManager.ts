/**
 * Manages the NOTES.md persistent memory file.
 * This file is the agent's writable working memory — project context,
 * task notes, and anything worth remembering across sessions.
 *
 * PROFILE.md is the read-only counterpart (see profileReader.ts).
 */

import fs from "node:fs/promises";
import path from "node:path";

const NOTES_FILENAME = "NOTES.md";
const MEMORY_DIR = "memory";

export interface NotesManager {
  /** Reads the full contents of NOTES.md, or empty string if absent */
  read(): Promise<string>;
  /** Replaces the entire content of NOTES.md */
  write(content: string): Promise<void>;
  /**
   * Appends a new section with a timestamp separator, unless the section is
   * substantially similar to content already present. Returns true if written,
   * false if skipped as a duplicate.
   */
  append(section: string): Promise<boolean>;
  /** Deletes all content from NOTES.md */
  clear(): Promise<void>;
  /** Returns the absolute path to NOTES.md */
  getPath(): string;
}

export function createNotesManager(profileDir: string): NotesManager {
  const notesPath = path.join(profileDir, MEMORY_DIR, NOTES_FILENAME);

  return {
    getPath(): string {
      return notesPath;
    },

    async read(): Promise<string> {
      try {
        return await fs.readFile(notesPath, "utf-8");
      } catch {
        return "";
      }
    },

    async write(content: string): Promise<void> {
      await ensureMemoryDir(profileDir);
      await fs.writeFile(notesPath, content, "utf-8");
    },

    async append(section: string): Promise<boolean> {
      await ensureMemoryDir(profileDir);
      const existing = await this.read();

      // Duplicate guard: skip if the incoming section shares too many key phrases
      // with existing content. Uses word-level Jaccard similarity on the last
      // ~2000 chars of existing notes (most recent entries) to stay O(1) in
      // file size.
      if (existing.trim() && isDuplicate(section, existing)) {
        return false;
      }

      const separator = existing.trim() ? "\n\n---\n\n" : "";
      const timestamp = new Date().toISOString().slice(0, 10);
      const newContent = `${existing}${separator}*${timestamp}*\n\n${section.trim()}\n`;
      await fs.writeFile(notesPath, newContent, "utf-8");
      return true;
    },

    async clear(): Promise<void> {
      await ensureMemoryDir(profileDir);
      await fs.writeFile(notesPath, "", "utf-8");
    },
  };
}

async function ensureMemoryDir(profileDir: string): Promise<void> {
  await fs.mkdir(path.join(profileDir, MEMORY_DIR), { recursive: true });
}

/**
 * Returns true when `incoming` is substantially similar to recent content in
 * `existing`, using word-level Jaccard similarity on the most recent 2000 chars.
 *
 * Threshold: ≥ 50 % overlap is considered a duplicate.
 */
function isDuplicate(incoming: string, existing: string): boolean {
  const JACCARD_THRESHOLD = 0.5;
  const EXISTING_WINDOW = 2000;

  const recentExisting = existing.slice(-EXISTING_WINDOW);
  const existingWords = tokenize(recentExisting);
  const incomingWords = tokenize(incoming);

  if (existingWords.size === 0 || incomingWords.size === 0) return false;

  let intersection = 0;
  for (const w of incomingWords) {
    if (existingWords.has(w)) intersection++;
  }

  const union = existingWords.size + incomingWords.size - intersection;
  return union > 0 && intersection / union >= JACCARD_THRESHOLD;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3)
  );
}
