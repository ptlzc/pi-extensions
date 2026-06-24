/**
 * skill-autocomplete — Show the skills list when typing `/` in the Pi editor
 *
 * Pi's built-in slash-command autocomplete only includes `skill:<name>`
 * entries when the `enableSkillCommands` setting is on, and they are mixed
 * together with every other slash command, prompt template, and extension
 * command. This extension guarantees that the skills loaded for the current
 * session are always offered as completions when the user types `/` at the
 * start of the input line.
 *
 * How it works:
 * 1. On `before_agent_start` we parse the `<available_skills>` block from the
 *    system prompt and cache the resulting skill list. This reflects exactly
 *    what Pi loaded (after any filtering applied by other extensions such as
 *    filter-skills), so the autocomplete never goes stale or out of sync.
 * 2. On the first `session_start` we register an autocomplete provider via
 *    `ctx.ui.addAutocompleteProvider`. The provider wraps the built-in one:
 *      - When the cursor is at a slash-command name position (line starts with
 *        `/` and contains no space), it merges skill suggestions on top of the
 *        built-in suggestions (deduplicated by completion value).
 *      - In every other position it delegates to the wrapped provider, so file
 *        path (`@`/`"`) completion, command-argument completion, and explicit
 *        Tab file completion are preserved unchanged.
 *
 * Selecting a skill inserts `/skill:<name> ` — the standard Pi skill-invocation
 * syntax — which the agent then loads via the read tool on the next turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterSkills, parseSkills, type SkillInfo } from "./src/skills";

/**
 * Minimal structural types matching `@earendil-works/pi-tui`'s autocomplete
 * interfaces. Defined locally so this extension does not need a direct
 * dependency on `pi-tui` (it is only a transitive dep of `pi-coding-agent`).
 * TypeScript's structural typing makes these assignable to the real types
 * expected by `ExtensionUIContext.addAutocompleteProvider`.
 */
interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
}

export default function (pi: ExtensionAPI) {
  // Skills loaded for the current session, refreshed every agent turn.
  let skills: SkillInfo[] = [];
  // Whether we have already registered our autocomplete provider for this
  // factory lifetime. Reload re-runs the factory (resetting this flag), so we
  // re-register exactly once after a reload.
  let registered = false;

  pi.on("before_agent_start", (event) => {
    skills = parseSkills(event.systemPrompt);
  });

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    // addAutocompleteProvider is only implemented in interactive (TUI) mode.
    if (!ctx.hasUI) return;
    registered = true;

    ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => {
      const provider: AutocompleteProvider = {
        // Ensure the popup opens as soon as the user types the leading slash.
        triggerCharacters: ["/"],

        async getSuggestions(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          options: { signal: AbortSignal; force?: boolean },
        ): Promise<AutocompleteSuggestions | null> {
          const currentLine = lines[cursorLine] ?? "";
          const textBeforeCursor = currentLine.slice(0, cursorCol);

          // Only augment slash-command NAME completion: the line must start
          // with `/` at column 0 and contain no space yet (so we are still
          // completing the command name, not its arguments). Anything else
          // (file paths, command arguments, mid-line `/`) is delegated to the
          // built-in provider untouched.
          const isSlashNameCompletion =
            textBeforeCursor.startsWith("/") &&
            !textBeforeCursor.includes(" ");

          if (!isSlashNameCompletion || skills.length === 0) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }

          const query = textBeforeCursor.slice(1); // text after the leading "/"
          const matched = filterSkills(skills, query);
          const skillItems: AutocompleteItem[] = matched.map((skill) => ({
            value: `skill:${skill.name}`,
            label: `skill:${skill.name}`,
            ...(skill.description && { description: skill.description }),
          }));

          // Merge with the built-in suggestions so regular slash commands,
          // prompt templates, and extension commands still appear alongside.
          const base = await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options,
          );

          if (skillItems.length === 0) return base;

          if (!base) {
            return {
              items: skillItems,
              prefix: textBeforeCursor,
            };
          }

          const seen = new Set(base.items.map((item) => item.value));
          const merged: AutocompleteItem[] = [
            ...base.items,
            ...skillItems.filter((item) => !seen.has(item.value)),
          ];
          return {
            items: merged,
            prefix: base.prefix,
          };
        },

        applyCompletion(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
          item: AutocompleteItem,
          prefix: string,
        ) {
          // The built-in provider already knows how to apply slash-command
          // completions (`/${value} `), and our skill items use the same
          // `skill:<name>` value format, so we delegate to it.
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
        },

        shouldTriggerFileCompletion(
          lines: string[],
          cursorLine: number,
          cursorCol: number,
        ): boolean {
          return current.shouldTriggerFileCompletion?.(
            lines,
            cursorLine,
            cursorCol,
          ) ?? false;
        },
      };

      // Preserve trigger characters declared by the wrapped provider.
      const baseTriggers = current.triggerCharacters ?? [];
      provider.triggerCharacters = Array.from(
        new Set(["/", ...baseTriggers]),
      );
      return provider;
    });
  });
}
