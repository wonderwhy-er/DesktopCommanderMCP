import fs from 'fs/promises';
import { Dirent } from 'fs';
import path from 'path';
import { parseSkillDirectory, SkillParseError } from './parser.js';
import type { SkillDescriptor, SkillRegistryError } from './types.js';
import { capture } from '../utils/capture.js';

function expandPath(rawPath: string): string {
  if (rawPath.startsWith('$CODEX_HOME')) {
    const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
    return rawPath.replace('$CODEX_HOME', codexHome);
  }
  return rawPath;
}

export class SkillRegistry {
  async scanSkills(skillDirs: string[]): Promise<{ skills: SkillDescriptor[]; errors: SkillRegistryError[] }> {
    const skills: SkillDescriptor[] = [];
    const errors: SkillRegistryError[] = [];

    for (const rawDir of skillDirs) {
      const dir = expandPath(rawDir);
      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        errors.push({
          path: dir,
          code: 'directory_read_failed',
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const skill = await parseSkillDirectory(fullPath);
          skills.push(skill);
        } catch (error) {
          if (error instanceof SkillParseError) {
            errors.push({
              path: fullPath,
              code: error.code,
              message: error.message
            });
          } else {
            errors.push({
              path: fullPath,
              code: 'unknown_skill_parse_error',
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    }

    capture('skill_registry_scan', {
      directory_count: skillDirs.length,
      skill_count: skills.length,
      error_count: errors.length
    });

    skills.sort((a, b) => a.id.localeCompare(b.id));
    return { skills, errors };
  }

  async findSkillById(skillDirs: string[], skillId: string): Promise<SkillDescriptor | null> {
    const { skills } = await this.scanSkills(skillDirs);
    return skills.find((skill) => skill.id === skillId) || null;
  }
}

export const skillRegistry = new SkillRegistry();
