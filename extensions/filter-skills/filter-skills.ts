/**
 * filter-skills — Project-level skill filtering for Pi
 *
 * Pi's built-in settings only allow filtering project-level skills from
 * `.pi/settings.json`. User-level skills from `~/.agents/skills/` and
 * `~/.pi/agent/skills/` cannot be disabled per-project.
 *
 * This extension solves that by intercepting `before_agent_start` and
 * rewriting the `<available_skills>` XML block in the system prompt to
 * remove skills matching patterns from `.pi/filter-skills.json`.
 *
 * Config file: `.pi/filter-skills.json`
 * ```json
 * { "exclude": ["k3s-ops", "se-*", "headscale-*"] }
 * ```
 *
 * Patterns support `*` wildcards. A skill is excluded if its name matches
 * any pattern. Use `!pattern` to force-include a skill that would otherwise
 * be excluded by a wildcard (takes precedence over excludes).
 *
 * ```json
 * {
 *   "exclude": ["se-*"],
 *   "include": ["se-coder"]
 * }
 * ```
 * This excludes all `se-*` skills except `se-coder`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface FilterConfig {
  exclude?: string[];
  include?: string[];
}

function loadConfig(cwd: string): FilterConfig {
  const configPath = join(cwd, ".pi", "filter-skills.json");
  if (!existsSync(configPath)) {
    return { exclude: [], include: [] };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as FilterConfig;
    return {
      exclude: parsed.exclude ?? [],
      include: parsed.include ?? [],
    };
  } catch (err) {
    console.error(`[filter-skills] Failed to read ${configPath}: ${err}`);
    return { exclude: [], include: [] };
  }
}

function globToRegex(pattern: string): RegExp {
  // Convert glob pattern to RegExp: * → .*, ? → ., escape everything else
  let regex = "";
  for (const ch of pattern) {
    if (ch === "*") {
      regex += ".*";
    } else if (ch === "?") {
      regex += ".";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`);
}

function shouldExclude(
  skillName: string,
  config: FilterConfig,
): boolean {
  const excludes = config.exclude ?? [];
  const includes = config.include ?? [];

  // Check if any exclude pattern matches
  let excluded = false;
  for (const pattern of excludes) {
    if (globToRegex(pattern).test(skillName)) {
      excluded = true;
      break;
    }
  }

  // Check if any include pattern matches (force-include overrides exclude)
  if (excluded) {
    for (const pattern of includes) {
      if (globToRegex(pattern).test(skillName)) {
        excluded = false;
        break;
      }
    }
  }

  return excluded;
}

/**
 * Parse the <available_skills> block from the system prompt and return
 * the names of all skills listed in it.
 */
function parseSkillNames(systemPrompt: string): string[] {
  const names: string[] = [];
  const blockMatch = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/,
  );
  if (!blockMatch) return names;

  const block = blockMatch[1];
  const skillRegex = /<skill>\s*<name>([^<]+)<\/name>/g;
  let match;
  while ((match = skillRegex.exec(block)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}

/**
 * Remove excluded <skill> entries from the <available_skills> block.
 * Returns the modified system prompt.
 */
function filterSkillsInPrompt(
  systemPrompt: string,
  config: FilterConfig,
): string {
  const blockMatch = systemPrompt.match(
    /(<available_skills>)([\s\S]*?)(<\/available_skills>)/,
  );
  if (!blockMatch) return systemPrompt;

  const openTag = blockMatch[1];
  const inner = blockMatch[2];
  const closeTag = blockMatch[3];

  // Split inner into individual <skill>...</skill> blocks
  const skillBlocks: string[] = [];
  const skillRegex = /<skill>[\s\S]*?<\/skill>/g;
  let match;
  let lastIndex = 0;
  const separators: string[] = [];
  while ((match = skillRegex.exec(inner)) !== null) {
    // Capture separator text before this skill block
    separators.push(inner.slice(lastIndex, match.index));
    skillBlocks.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  separators.push(inner.slice(lastIndex)); // trailing text

  // Filter skill blocks
  const keptBlocks: string[] = [];
  const keptSeparators: string[] = [];
  for (let i = 0; i < skillBlocks.length; i++) {
    const block = skillBlocks[i];
    const nameMatch = block.match(/<name>([^<]+)<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : "";
    if (!shouldExclude(name, config)) {
      keptBlocks.push(block);
      keptSeparators.push(separators[i]);
    }
  }
  keptSeparators.push(separators[separators.length - 1]);

  // Rebuild inner
  let newInner = "";
  for (let i = 0; i < keptBlocks.length; i++) {
    newInner += keptSeparators[i] + keptBlocks[i];
  }
  newInner += keptSeparators[keptSeparators.length - 1];

  // If all skills were filtered out, remove the entire skills section
  // (the header text + empty block) to keep the prompt clean
  if (keptBlocks.length === 0) {
    // Remove the skills section: everything from the header line to the
    // closing </available_skills> tag, including preceding newlines
    const sectionRegex =
      /\n*The following skills provide specialized instructions[\s\S]*?<\/available_skills>\n*/;
    return systemPrompt.replace(sectionRegex, "");
  }

  return systemPrompt.replace(
    /<available_skills>[\s\S]*?<\/available_skills>/,
    openTag + newInner + closeTag,
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const config = loadConfig(event.systemPromptOptions.cwd);
    if (
      (config.exclude ?? []).length === 0 &&
      (config.include ?? []).length === 0
    ) {
      return; // No filtering configured
    }

    const skillNames = parseSkillNames(event.systemPrompt);
    if (skillNames.length === 0) {
      return; // No skills in prompt
    }

    const filtered = filterSkillsInPrompt(event.systemPrompt, config);
    if (filtered !== event.systemPrompt) {
      const excludedCount =
        skillNames.length -
        parseSkillNames(filtered).length;
      if (excludedCount > 0) {
        console.error(
          `[filter-skills] Excluded ${excludedCount} skill(s) from system prompt`,
        );
      }
      return { systemPrompt: filtered };
    }
  });
}
