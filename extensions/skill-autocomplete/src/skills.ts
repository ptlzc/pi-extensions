/**
 * Skill parsing helpers.
 *
 * Skills are surfaced to the model via an `<available_skills>` XML block in
 * the system prompt (see Pi's `formatSkillsForPrompt`). Each entry contains a
 * `<name>`, `<description>`, and `<location>`. We parse that block to build the
 * autocomplete list, so the extension always reflects exactly the skills Pi
 * loaded for the current session (after any filtering by other extensions).
 */

export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Parse the `<available_skills>` block from a system prompt and return all
 * skills listed in it (name + description). Returns an empty array when the
 * block is absent (e.g. no skills loaded, or all filtered out).
 */
export function parseSkills(systemPrompt: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const blockMatch = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/,
  );
  if (!blockMatch) return skills;

  const block = blockMatch[1];
  const skillRegex = /<skill>([\s\S]*?)<\/skill>/g;
  let match: RegExpExecArray | null;
  while ((match = skillRegex.exec(block)) !== null) {
    const inner = match[1];
    const name = inner.match(/<name>([^<]*)<\/name>/)?.[1]?.trim();
    const description = inner
      .match(/<description>([^<]*)<\/description>/)
      ?.[1]?.trim();
    if (name) {
      skills.push({ name, description: description ?? "" });
    }
  }
  return skills;
}

/**
 * Fuzzy-ish filter for skill autocomplete.
 *
 * Matches are case-insensitive. A skill matches the query when the query is a
 * substring of `skill:<name>` (the completion value) or of `<name>` itself.
 * `startsWith` matches are sorted before inner-substring matches.
 */
export function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;

  const startsWith: SkillInfo[] = [];
  const contains: SkillInfo[] = [];
  for (const skill of skills) {
    const value = `skill:${skill.name}`.toLowerCase();
    const name = skill.name.toLowerCase();
    if (value.startsWith(q) || name.startsWith(q)) {
      startsWith.push(skill);
    } else if (value.includes(q) || name.includes(q)) {
      contains.push(skill);
    }
  }
  return [...startsWith, ...contains];
}
