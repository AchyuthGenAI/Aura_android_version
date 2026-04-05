import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ipcMain } from "electron";
import { ConfigManager } from "./config-manager";

export interface SkillManifest {
  id: string; // Directory name usually
  name: string;
  description: string;
  emoji?: string;
  path: string;
}

export class SkillRegistry {
  private skills: Map<string, SkillManifest> = new Map();
  private loaded = false;

  constructor(private readonly configManager: ConfigManager) {}

  /**
   * Initializes the registry, scanning the OpenClaw workspace for skills.
   */
  async initialize(): Promise<void> {
    const openClawHome = this.configManager.getOpenClawHomePath();
    const skillsDir = path.join(openClawHome, ".openclaw", "workspace", "skills");

    try {
      await fs.access(skillsDir);
    } catch {
      console.log(`[SkillRegistry] No skills directory found at ${skillsDir}`);
      this.loaded = true;
      this.registerIpc();
      return;
    }

    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(skillsDir, entry.name);
        const mdPath = path.join(skillPath, "SKILL.md");

        try {
          const content = await fs.readFile(mdPath, "utf8");
          const manifest = this.parseSkillFrontmatter(entry.name, content, skillPath);
          if (manifest) {
            this.skills.set(manifest.id, manifest);
          }
        } catch (err) {
          // Skip if SKILL.md doesn't exist or isn't readable
        }
      }

      console.log(`[SkillRegistry] Loaded ${this.skills.size} skills.`);
      this.loaded = true;
      this.registerIpc();
    } catch (err) {
      console.error("[SkillRegistry] Failed to load skills:", err);
      this.loaded = true;
      this.registerIpc();
    }
  }

  getSkills(): SkillManifest[] {
    return Array.from(this.skills.values());
  }

  getSkill(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  searchSkills(query: string): SkillManifest[] {
    const q = query.toLowerCase();
    return this.getSkills().filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }

  private parseSkillFrontmatter(dirName: string, content: string, skillPath: string): SkillManifest | null {
    const frontmatterRegex = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/;
    const match = content.match(frontmatterRegex);

    if (!match) return null;

    const fmText = match[1];
    if (!fmText) return null;

    let name = dirName;
    let description = "";
    let emoji = "⚙️";

    const lines = fmText.split(/\r?\n/);
    let inMetadata = false;
    let metadataStr = "";

    for (const line of lines) {
      if (inMetadata) {
        metadataStr += line + "\n";
        continue;
      }

      if (line.startsWith("name:")) {
        name = line.substring(5).trim().replace(/^["']|["']$/g, "");
      } else if (line.startsWith("description:")) {
        description = line.substring(12).trim().replace(/^["']|["']$/g, "");
      } else if (line.startsWith("metadata:")) {
        inMetadata = true;
        metadataStr += line.substring(9).trim() + "\n";
      }
    }

    if (inMetadata && metadataStr.trim()) {
      try {
        // Very basic json extraction if possible, or just regex out emoji if standard json parsing fails
        // The metadata is often weirdly formatted json (or yaml objects).
        const emojiMatch = metadataStr.match(/"emoji"\s*:\s*"([^"]+)"/);
        if (emojiMatch && emojiMatch[1]) {
          emoji = emojiMatch[1];
        }
      } catch (e) {
        // Ignore JSON/Regex errors
      }
    }

    return {
      id: dirName,
      name,
      description,
      emoji,
      path: skillPath,
    };
  }

  private registerIpc() {
    ipcMain.removeHandler("skills.list");
    ipcMain.handle("skills.list", () => {
      // Return lightweight list
      return this.getSkills().map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        emoji: s.emoji
      }));
    });

    ipcMain.removeHandler("skills.get");
    ipcMain.handle("skills.get", (_, id: string) => {
      return this.skills.get(id);
    });
  }
}
