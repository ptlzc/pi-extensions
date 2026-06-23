AGENTS.md

This repo hosts Pi coding agent extensions.

## Structure

- `extensions/<name>/` — each extension is a self-contained directory
- `extensions/<name>/<name>.ts` — extension entry point (TS module)
- `extensions/<name>/package.json` — npm metadata with `pi` manifest
- `extensions/<name>/README.md` — extension-specific docs

## Conventions

- Extensions are TypeScript modules with a default export factory function
- The factory receives `ExtensionAPI` from `@earendil-works/pi-coding-agent`
- No build step needed — Pi loads `.ts` files directly via its extension loader
- Each extension should be independently installable via `pi install`
- Root `package.json` has a `pi` manifest that bundles all extensions

## Development

```bash
# Test an extension locally
pi --skill ./extensions/filter-skills

# Or symlink into ~/.pi/agent/extensions/
ln -s $(pwd)/extensions/filter-skills ~/.pi/agent/extensions/filter-skills
```
