# skill-autocomplete

Show the **skills list** when typing `/` in the [Pi](https://pi.dev) editor.

## Problem

Pi's built-in slash-command autocomplete only includes `skill:<name>` entries
when the `enableSkillCommands` setting is on, and they are mixed together with
every other slash command, prompt template, and extension command. If you turn
that setting off (or want skills to always be reachable), there is no easy way
to discover the skills loaded for the current session from the input box.

## Solution

This extension registers an autocomplete provider that wraps Pi's built-in one.
When the cursor is at a slash-command name position (the line starts with `/`
and contains no space yet), it merges the current session's skills — with their
descriptions — on top of the built-in suggestions. Selecting a skill inserts
`/skill:<name> `, the standard Pi skill-invocation syntax.

The skill list is parsed from the `<available_skills>` block of the system
prompt on every agent turn, so it always reflects exactly what Pi loaded for
the current session (including after filtering by extensions such as
`filter-skills`).

## Install

```bash
# From GitHub (recommended)
pi install git:github.com/ptlzc/pi-extensions

# Or project-local
pi install -l git:github.com/ptlzc/pi-extensions
```

## Usage

1. Start Pi in a project that has skills loaded.
2. Type `/` at the beginning of the input line.
3. The autocomplete popup shows all available skills (`skill:<name>`) with their
   descriptions, alongside the usual slash commands.
4. Filter by continuing to type (e.g. `/se` matches `se-coder`, `se-env`, …).
5. Select a skill to insert `/skill:<name> ` and press Enter to invoke it.

## How it works

1. On `before_agent_start`, the extension parses the `<available_skills>` XML
   block from the system prompt and caches the skill list (name + description).
2. On the first `session_start`, it calls `ctx.ui.addAutocompleteProvider` to
   register a provider that wraps the built-in one:
   - **Slash-command name position** (`/…` with no space, at column 0): merges
     skill suggestions on top of the built-in suggestions, deduplicated by
     completion value. Skill items use `value: "skill:<name>"` so the built-in
     `applyCompletion` produces `/skill:<name> `.
   - **Every other position**: delegates to the wrapped provider unchanged, so
     file path (`@`/`"`) completion, command-argument completion, and explicit
     Tab file completion keep working.
3. On reload, Pi re-runs the extension factory, so the provider is re-registered
   exactly once with a fresh closure.

The extension is TUI-only: in non-interactive modes (RPC, print, JSON) it
registers nothing.

## Compatibility

Works with `@earendil-works/pi-coding-agent` >= 0.79.0. Composes cleanly with
`filter-skills` — the autocomplete list mirrors whatever skills
`filter-skills` left in the system prompt.

## License

MIT
