# pi-extensions

A collection of [Pi](https://pi.dev) coding agent extensions.

## Extensions

| Extension | Description |
|-----------|-------------|
| [filter-skills](./extensions/filter-skills/) | Project-level skill filtering — disable user-level skills per project |
| [subagents](./extensions/subagents/) | Configurable multi-subagent — pi-type and cli-type (devin/codex) with model fallback |

## Install

```bash
# Install all extensions from this repo
pi install git:github.com/ptlzc/pi-extensions

# Or project-local
pi install -l git:github.com/ptlzc/pi-extensions
```

After install, enable/disable extensions via `pi config`.

## License

MIT
