# subagents

Configurable multi-subagent extension for [Pi](https://pi.dev) coding agent.

## Features

- **Two subagent types**: `pi` (isolated pi subprocess) and `cli` (external command)
- **Fallback = complete subagent**: each fallback is a full definition (type, model, thinking, tools, prompt, command — not just a model name)
- **Prompt files**: `.md` (plain markdown) or `.j2` (Jinja2 template with input validation)
- **Thinking level**: `off` / `minimal` / `low` / `medium` / `high` / `xhigh`
- **Template variables** in CLI args: `{task}`, `{cwd}`, `{agent_name}`
- **Parallel execution**: max 8 tasks, 4 concurrent
- **Project-level config**: `.pi/subagents/config.yaml`

## Install

```bash
pi install git:github.com/ptlzc/pi-extensions
```

## Config directory structure

```
.pi/subagents/
├── config.yaml          # Main configuration
└── prompts/             # Prompt files
    ├── scout.md         # Plain markdown prompt
    ├── reviewer.j2      # Jinja2 template with input validation
    └── planner.j2       # Another Jinja2 template
```

## Configure

### Basic example

`.pi/subagents/config.yaml`:

```yaml
subagents:
  - name: scout
    description: Fast codebase recon
    type: pi
    model: ai-relay/gpt-5.2
    thinking: low
    tools: [read, grep, find, ls, bash]
    prompt: prompts/scout.md

  - name: devin
    description: Delegate to Devin CLI
    type: cli
    command: devin
    args: ["-p", "{task}"]
    timeout: 600

defaults:
  timeout: 120
  thinking: off
```

### Fallback = complete subagent

Each fallback entry is a **complete subagent definition** — it can have a different type, model, thinking level, tools, prompt, or even be a CLI command:

```yaml
subagents:
  - name: reviewer
    description: Code review specialist
    type: pi
    model: sonnet
    thinking: high
    tools: [read, grep, find, ls, bash]
    prompt: prompts/reviewer.j2
    prompt_input:
      focus_areas: ["security", "performance"]
      strict: true
    fallback:
      # Fallback 1: different model with lower thinking
      - type: pi
        model: gpt-4o
        thinking: medium
        tools: [read, grep, find, ls]
        prompt: prompts/reviewer.j2
        prompt_input:
          focus_areas: ["security", "performance"]
          strict: false

      # Fallback 2: completely different type — CLI agent
      - type: cli
        command: devin
        args: ["-p", "Review this code: {task}"]
        timeout: 600

      # Fallback 3: another CLI agent
      - type: cli
        command: codex
        args: ["--quiet", "{task}"]
        timeout: 300
```

### Inline prompt (no file)

```yaml
subagents:
  - name: echo-test
    description: Simple echo test
    type: cli
    command: echo
    args: ["Task: {task}"]
    timeout: 5

  - name: quick-scout
    description: Quick inline prompt
    type: pi
    model: haiku
    prompt: |
      You are a fast code scout.
      Find relevant code and return a compressed summary.
      Do not write or edit files.
```

### Jinja2 prompt templates (`.j2`)

Create `.pi/subagents/prompts/reviewer.j2`:

```jinja2
---
inputs:
  - name: focus_areas
    type: array
    required: true
  - name: strict
    type: boolean
    default: false
  - name: max_files
    type: number
    default: 10
---
You are a code review specialist.

Focus areas: {{ focus_areas | join(", ") }}.
Maximum files to review: {{ max_files }}.

{% if strict %}
Be very strict. Flag all issues, even minor ones.
{% else %}
Focus on major issues only.
{% endif %}

Review each file thoroughly and provide actionable feedback.
```

In `config.yaml`, provide the input:

```yaml
subagents:
  - name: reviewer
    description: Code review specialist
    type: pi
    model: sonnet
    thinking: high
    prompt: prompts/reviewer.j2
    prompt_input:
      focus_areas: ["security", "performance", "maintainability"]
      strict: true
      max_files: 20
```

**Validation**: The extension parses the `inputs` frontmatter and validates:
- Required fields are present
- Type matches (`string`, `number`, `boolean`, `array`, `object`)
- Defaults are applied for optional fields

If validation fails, errors are logged to stderr and the template is rendered with whatever input is available.

## Config Reference

### Subagent fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier |
| `description` | string | yes | What this subagent does (shown to model) |
| `type` | `"pi"` \| `"cli"` | yes | Subagent type |
| `prompt` | string | no | Inline text or file path (relative to `.pi/subagents/`) |
| `prompt_input` | object | no | Input variables for `.j2` template rendering |
| `model` | string | pi-type | Model ID (e.g. `sonnet`, `ai-relay/gpt-5.2`) |
| `thinking` | string | no | `off`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `max_context` | number | no | Max context window (reserved for future use) |
| `tools` | string[] | no | Tools available to pi-type subagent |
| `command` | string | cli-type | Command to execute |
| `args` | string[] | cli-type | Command arguments (supports template vars) |
| `timeout` | number | no | Timeout in seconds (cli-type, default: 120) |
| `cwd` | string | no | Working directory (cli-type, relative to project) |
| `fallback` | FallbackConfig[] | no | Fallback subagent definitions |

### Fallback fields

Each fallback entry supports the same fields as a subagent **except** `name`, `description`, and `fallback` (no nested fallbacks). Fallbacks are tried in order until one succeeds.

### Defaults

| Field | Default | Description |
|-------|---------|-------------|
| `timeout` | `120` | Default timeout for CLI subagents (seconds) |
| `thinking` | `off` | Default thinking level for pi-type subagents |

### J2 template frontmatter

```yaml
---
inputs:
  - name: variable_name
    type: string | number | boolean | array | object
    required: true | false
    default: <value>
---
```

### Template variables (CLI args)

| Variable | Replaced with |
|----------|---------------|
| `{task}` | The task string |
| `{cwd}` | Working directory |
| `{agent_name}` | The subagent name |

## How it works

### Fallback chain

When a subagent is invoked, the primary definition is tried first. If it fails (non-zero exit, error stop reason, timeout), each fallback is tried in order:

```
primary (pi:sonnet:high) → fallback 1 (pi:gpt-4o:medium) → fallback 2 (cli:devin) → fallback 3 (cli:codex)
```

- User abort (Ctrl+C) stops immediately — no more fallbacks
- Each fallback is a **complete subagent** with its own type, model, thinking, tools, and prompt
- The result reports which attempt succeeded (e.g. `2/3 attempts`)

### Pi-type

Spawns `pi --mode json -p --no-session` with:
- `--model provider/model:thinking` (if thinking is set)
- `--thinking <level>` (if model not specified but thinking is)
- `--tools <comma-separated>`
- `--append-system-prompt <temp-file>` (system prompt written to temp file)
- Isolated context window — no parent session leakage

### CLI-type

Spawns the configured command with template-substituted arguments:
- stdout captured as output
- stderr captured as error context
- Timeout kills with SIGTERM
- Abort signal propagated from parent

## License

MIT
