# outline

Structural outline tool for [Pi](https://pi.dev) coding agent.

Generates file structure outlines (functions, classes, sections with line numbers) to enable precise line-range reads instead of whole-file reads. **Recommended first step for files >200 lines.**

## Features

- **Markdown outline**: regex-based heading hierarchy parser (`.md`, `.markdown`, `.md.j2`, `.j2`)
- **Source code outline**: codegraph SDK (tree-sitter WASM) via `extractFromSource`
- **26 languages**: TypeScript, JavaScript, Python, Go, Rust, Java, C#, C/C++, Ruby, Swift, Kotlin, Dart, PHP, Scala, Lua, R, and more
- **Line ranges**: every node shows `[startLine,endLine]` for precise reads
- **Hierarchy**: nested classes/methods shown with indentation

## Install

```bash
pi install git:github.com/ptlzc/pi-extensions
```

## Usage

The `outline` tool is automatically available to Pi after installation.

```
outline(file: "src/large-file.ts")
```

### Markdown output example

```
file README.md
# Title [1,100]
## Section A [5,30]
### Subsection [10,20]
## Section B [35,80]
```

### Source code output example

```
file src/auth.ts
class AuthService [1,80]
  method login [5,25]
  method logout [27,35]
  method validateToken [37,60]
function hashPassword [82,95]
```

## When to use

| Scenario | Use outline? |
|----------|-------------|
| File >200 lines | Yes — outline first, then read specific ranges |
| Markdown with multiple sections | Yes — cheap regex parsing |
| Small file (<200 lines) | No — use native `read` directly |
| Config files (.yaml/.json/.toml) | No — codegraph doesn't parse them |
| Known exact line range | No — use native `read` with offset/limit |

## How it works

### Markdown path

Pure regex parsing of `#`-prefixed headings, respecting fenced code blocks. No external dependencies. Outputs heading hierarchy with line ranges.

### Source code path

Uses `@colbymchenry/codegraph` SDK — a self-contained tree-sitter WASM based code intelligence library:

1. `detectLanguage(filePath)` — identifies language from extension
2. `initGrammars()` — initializes tree-sitter WASM runtime
3. `loadGrammarsForLanguages([lang])` — loads the specific grammar
4. `CodeGraph.extractFromSource(relPath, source)` — parses source text
5. Filters to structural kinds (class, function, method, interface, etc.)
6. Builds hierarchy from line-range containment
7. Renders as indented text outline

No persisted index required — `extractFromSource` parses source text directly.

## Supported languages

typescript, tsx, javascript, jsx, python, go, rust, java, c, cpp, csharp, php, ruby, swift, kotlin, dart, pascal, scala, lua, r, luau, objc, svelte, vue, astro, liquid

## License

MIT
