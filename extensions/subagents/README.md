# subagents

Configurable multi-subagent extension for [Pi](https://pi.dev) coding agent.

Supports two subagent types:
- **pi-type** — spawns a `pi` subprocess with isolated context, specific model/tools/prompt
- **cli-type** — spawns an external CLI command (e.g. `devin`, `codex`, `aider`)

## Features

- **Model fallback** — try primary model, fall back to alternatives on failure
- **Prompt templates** — inline `system_prompt` or `system_prompt_file` reference
- **Parallel execution** — run multiple subagents concurrently (max 8, 4 concurrent)
- **Template variables** — `{task}`, `{cwd}`, `{agent_name}` in CLI args
- **Project-level YAML config** — `.pi/subagents.yaml`
- **Timeout support** — for CLI-type subagents

## Install

```bash
pi install git:github.com/ptlzc/pi-extensions
```

## Configure

Create `.pi/subagents.yaml` in your project root:

```yaml
subagents:
  # Pi-type: spawn pi with isolated context
  - name: scout
    description: Fast codebase recon, returns compressed context
    type: pi
    model: claude-haiku-4-5
    fallback_models:
      - gpt-4o-mini
      - sonnet
    tools:
      - read
      - grep
      - find
      - ls
      - bash
    system_prompt: |
      You are a fast code scout.
      Find relevant code quickly and return a compressed summary.
      Do not write or edit any files.

  # Pi-type with prompt file
  - name: reviewer
    description: Code review specialist
    type: pi
    model: sonnet
    fallback_models:
      - gpt-4o
      - opus
    tools:
      - read
      - grep
      - find
      - ls
    system_prompt_file: ./prompts/reviewer.md

  # CLI-type: delegate to external agent
  - name: devin
    description: Delegate complex tasks to Devin CLI
    type: cli
    command: devin
    args:
      - "-p"
      - "{task}"
    timeout: 600

  # CLI-type: delegate to Codex CLI
  - name: codex
    description: Delegate to Codex CLI
    type: cli
    command: codex
    args:
      - "--quiet"
      - "{task}"
    timeout: 300

  # CLI-type: run aider
  - name: aider
    description: Delegate to aider for bulk edits
    type: cli
    command: aider
    args:
      - "--message"
      - "{task}"
      - "--no-auto-commits"
    timeout: 600
    cwd: .

# Optional defaults
defaults:
  timeout: 120        # default CLI timeout in seconds
  max_tokens: 16384   # default max output tokens for pi-type
```

## Usage

The extension registers a `subagent` tool. The model can invoke it in two modes:

### Single mode

```
Use scout to find all authentication-related code
```
```
Use devin to refactor the entire auth module
```

### Parallel mode

```
Run 2 scouts in parallel: one to find models, one to find controllers
```

## Config Reference

### Subagent fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique identifier for the subagent |
| `description` | string | yes | What this subagent does (shown to the model) |
| `type` | `"pi"` \| `"cli"` | yes | Subagent type |
| `model` | string | pi-type | Primary model (e.g. `sonnet`, `gpt-4o`, `ai-relay/gpt-5.2`) |
| `fallback_models` | string[] | no | Models to try if primary fails |
| `tools` | string[] | no | Tools available to pi-type subagent |
| `system_prompt` | string | no | Inline system prompt (multiline with `\|`) |
| `system_prompt_file` | string | no | Path to system prompt file (relative to `.pi/`) |
| `max_tokens` | number | no | Max output tokens for pi-type |
| `command` | string | cli-type | Command to execute |
| `args` | string[] | cli-type | Command arguments (supports template vars) |
| `timeout` | number | no | Timeout in seconds (cli-type, default: 120) |
| `cwd` | string | no | Working directory (cli-type, relative to project) |

### Template variables (cli-type args)

| Variable | Replaced with |
|----------|---------------|
| `{task}` | The task string |
| `{cwd}` | Working directory |
| `{agent_name}` | The subagent name |

### Defaults

| Field | Default | Description |
|-------|---------|-------------|
| `timeout` | `120` | Default timeout for CLI subagents (seconds) |
| `max_tokens` | `16384` | Default max tokens for pi-type subagents |

## How it works

### pi-type

Spawns a `pi` subprocess with `--mode json -p --no-session`:
- Isolated context window (no parent session leakage)
- Specified model and tools
- System prompt written to temp file, passed via `--append-system-prompt`
- Output captured from JSON event stream
- On failure (exit code ≠ 0 or error stop reason), tries next fallback model

### cli-type

Spawns the configured command with template-substituted arguments:
- stdout captured as the subagent output
- stderr captured as error context
- Timeout kills the process with SIGTERM
- Abort signal propagated from parent

## Model fallback

For pi-type subagents, models are tried in order:

```yaml
model: sonnet          # tried first
fallback_models:       # tried in order if primary fails
  - gpt-4o
  - opus
```

A model is considered "failed" if:
- Process exits with non-zero code
- Stop reason is `"error"`
- API key is missing or invalid

If all models fail, the last error is returned to the parent agent.

User abort (Ctrl+C) stops immediately without trying fallbacks.

## License

MIT
