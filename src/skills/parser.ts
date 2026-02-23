import fs from 'fs/promises';
import path from 'path';
import type { SkillDescriptor } from './types.js';

interface SkillFrontmatter {
  name: string;
  description: string;
}

export class SkillParseError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SkillParseError';
  }
}

function parseFrontmatter(markdown: string): SkillFrontmatter {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) {
    throw new SkillParseError('missing_frontmatter', 'Missing YAML frontmatter');
  }

  const lines = match[1].split('\n');
  let name = '';
  let description = '';

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (!trimmed.includes(':')) {
      throw new SkillParseError(
        'invalid_frontmatter',
        `Malformed frontmatter line ${index + 1}: "${trimmed}"`
      );
    }

    const nameMatch = trimmed.match(/^name:\s*["']?(.*?)["']?$/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      continue;
    }
    const descMatch = trimmed.match(/^description:\s*["']?(.*?)["']?$/);
    if (descMatch) {
      description = descMatch[1].trim();
    }
  }

  if (!name || !description) {
    throw new SkillParseError(
      'missing_required_fields',
      'Frontmatter must include name and description'
    );
  }

  return { name, description };
}

async function safeListFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function parseSkillDirectory(skillDir: string): Promise<SkillDescriptor> {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const body = await fs.readFile(skillPath, 'utf8');
  const frontmatter = parseFrontmatter(body);
  const id = path.basename(skillDir);

  const scripts = await safeListFiles(path.join(skillDir, 'scripts'));
  const references = await safeListFiles(path.join(skillDir, 'references'));
  const assets = await safeListFiles(path.join(skillDir, 'assets'));

  const tagSet = new Set<string>();
  if (scripts.length > 0) tagSet.add('scripts');
  if (references.length > 0) tagSet.add('references');
  if (assets.length > 0) tagSet.add('assets');

  return {
    id,
    name: frontmatter.name,
    description: frontmatter.description,
    path: skillDir,
    tags: Array.from(tagSet),
    resources: {
      scripts,
      references,
      assets
    }
  };
}
