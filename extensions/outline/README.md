# outline

Structural outline tool for [Pi](https://pi.dev) coding agent.

Generates file structure outlines (functions, classes, sections, YAML keys,
Markdown headings) with 1-based line ranges to enable precise line-range
reads instead of whole-file reads. **Recommended first step for files >200
lines.**

## Architecture

| file type | backend | dependencies |
|-----------|---------|-------------|
| Markdown  | pure TS (regex) | none |
| YAML      | pure TS (indentation) | none |
| Source    | Rust binary (tree-sitter AST) | `~/.pi/agent/bin/devin-tools-mock` |

Source code outline is delegated to the Rust `devin-tools-mock` binary,
which has tree-sitter grammars **compiled in** — zero runtime dependencies
(no node/sqlite/npm packages).

## Features

- **Markdown outline**: regex-based heading hierarchy (`.md`, `.markdown`, `.md.j2`, `.j2`)
- **YAML outline**: indentation-based key/sequence/document parser (`.yaml`, `.yml`)
- **Source code outline**: tree-sitter AST via Rust binary
- **11 languages**: Python, Rust, TypeScript, JavaScript, Go, Java, C, C++, Ruby, Bash, Lua
- **Accurate nesting**: methods inside classes show as depth-1 children
- **Rich kinds**: class, method, function, struct, trait, interface, enum, namespace, operator[], ~destructor
- **Line ranges**: every node shows `[startLine,endLine]` for precise reads
- **max_depth**: optional parameter to limit nesting depth

## Install

```bash
pi install git:github.com/ptlzc/pi-extensions
```

The Rust binary must be at `~/.pi/agent/bin/devin-tools-mock`. Build it from
the `devin-tools-mock` repo:

```bash
cd devin-tools-mock
cargo build --release
cp target/release/devin-tools-mock ~/.pi/agent/bin/
```

Override the binary path via `DEVIN_TOOLS_MOCK_BIN` env var if needed.

## Usage

```
outline(file_path: "/abs/path/to/large-file.ts")
outline(file_path: "/abs/path/to/config.yaml", max_depth: 2)
```

### Source code output example

```
outline of /path/to/auth.ts (source, 95 lines, 4 entries):
class AuthService [1,80]
  method login [5,25]
  method logout [27,35]
function hashPassword [82,95]
```

### YAML output example

```
outline of /path/to/docker-compose.yaml (yaml, 14 lines, 5 entries):
key services [2,10]
  key web [3,8]
    leaf image [4,4]
  key db [9,10]
key networks [11,12]
```

### Markdown output example

```
outline of /path/to/README.md (markdown, 100 lines, 4 entries):
heading Title [1,100]
  heading Section A [5,30]
    heading Subsection [10,20]
  heading Section B [35,80]
```

## License

MIT
