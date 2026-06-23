# filter-skills

Project-level skill filtering for [Pi](https://pi.dev) coding agent.

## Problem

Pi's built-in `.pi/settings.json` only filters **project-level** skills (from `.pi/skills/` and `.agents/skills/` in the project tree). **User-level skills** from `~/.agents/skills/` and `~/.pi/agent/skills/` cannot be disabled per-project — they always load.

If you have 30+ global skills (k3s-ops, se-*, headscale-pro-operator, etc.) but only need 2-3 for a specific project, they all show up in the system prompt, wasting context tokens and confusing the model.

## Solution

This extension intercepts the `before_agent_start` event and rewrites the `<available_skills>` XML block in the system prompt to remove unwanted skills — **including user-level ones**.

## Install

```bash
# From GitHub (recommended)
pi install git:github.com/ptlzc/pi-extensions

# Or project-local
pi install -l git:github.com/ptlzc/pi-extensions
```

## Configure

Create `.pi/filter-skills.json` in your project root:

```json
{
  "exclude": ["k3s-ops", "se-*", "headscale-*"],
  "include": ["se-coder"]
}
```

### Pattern syntax

| Pattern | Matches |
|---------|---------|
| `k3s-ops` | Exact match |
| `se-*` | All skills starting with `se-` |
| `se-??` | `se-` + exactly 2 chars |
| `*` | All skills |

### include (force-include)

`include` patterns **override** `exclude` patterns. Use this to keep specific skills when excluding with wildcards:

```json
{
  "exclude": ["se-*"],
  "include": ["se-coder", "se-env"]
}
```

This excludes all `se-*` skills **except** `se-coder` and `se-env`.

## How it works

1. Pi loads all skills (user + project) and builds the system prompt with an `<available_skills>` XML block
2. Before each agent turn, the `before_agent_start` event fires with the full system prompt
3. This extension parses the XML block, filters skill entries by name against `.pi/filter-skills.json`
4. The modified system prompt (with excluded skills removed) is returned to Pi

The original skill files on disk are not touched — only the system prompt is filtered. Skills can still be loaded manually via `/skill:name` if needed.

## Example

With `.pi/filter-skills.json`:

```json
{
  "exclude": ["k3s-*", "headscale-*", "terraform-*", "drawio-*"]
}
```

Before (30 skills in prompt):
```
<available_skills>
  <skill><name>k3s-ops</name>...</skill>
  <skill><name>k3s-app-deploy</name>...</skill>
  <skill><name>headscale-pro-operator</name>...</skill>
  <skill><name>se-coder</name>...</skill>
  ...
</available_skills>
```

After (26 skills in prompt):
```
<available_skills>
  <skill><name>se-coder</name>...</skill>
  ...
</available_skills>
```

## License

MIT
