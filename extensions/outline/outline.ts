/**
 * outline — Structural outline tool for Pi
 *
 * Generates file structure outlines (functions, classes, sections, YAML keys,
 * Markdown headings) with 1-based line ranges to enable precise line-range
 * reads instead of whole-file reads.
 *
 * Three paths:
 *   - Markdown (.md, .markdown, .md.j2, .j2): regex-based heading parser
 *   - YAML (.yaml, .yml): indentation-based key/sequence/document parser
 *   - Source code: Rust `devin-tools-mock` binary (tree-sitter AST, zero deps)
 *
 * Recommended first step for files >200 lines.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, extname, basename, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OutlineEntry {
  depth: number;
  kind: string;
  name: string;
  line: number;
  end_line: number;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const MARKDOWN_EXTS = new Set([".md", ".markdown", ".md.j2", ".markdown.j2", ".j2"]);
const YAML_EXTS = new Set([".yaml", ".yml"]);

function classify(filePath: string): "markdown" | "yaml" | "source" {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath).toLowerCase();
  if (MARKDOWN_EXTS.has(ext) || name.endsWith(".md.j2") || name.endsWith(".markdown.j2")) {
    return "markdown";
  }
  if (YAML_EXTS.has(ext)) return "yaml";
  return "source";
}

// ---------------------------------------------------------------------------
// Markdown outline (pure regex, no deps)
// ---------------------------------------------------------------------------

const HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function outlineMarkdown(lines: string[], maxDepth?: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const stack: { level: number; idx: number }[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const total = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const char = marker[0];
      const len = marker.length;
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLen = len;
      } else if (char === fenceChar && len >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const match = line.match(HEADING_RE);
    if (!match) continue;
    const level = match[2].length;
    if (maxDepth !== undefined && level > maxDepth) continue;
    let title = match[3].trim().replace(/[ \t]+#{1,}[ \t]*$/, "").trim();

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      const top = stack.pop()!;
      if (entries[top.idx].end_line === total) {
        entries[top.idx].end_line = Math.max(i, entries[top.idx].line);
      }
    }

    const depth = stack.length;
    const idx = entries.length;
    entries.push({ depth, kind: "heading", name: title, line: i + 1, end_line: total });
    stack.push({ level, idx });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// YAML outline (indentation-based, no deps)
// ---------------------------------------------------------------------------

function outlineYaml(lines: string[], maxDepth?: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const stack: { indent: number; idx: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Document marker
    if (line.trim() === "---" || line.trim() === "...") {
      while (stack.length > 0) stack.pop();
      entries.push({ depth: 0, kind: "document", name: line.trim(), line: i + 1, end_line: i + 1 });
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.slice(indent);

    // Sequence item
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      const keyMatch = rest.match(/^([^:]+):\s*(.*)$/);
      const name = keyMatch ? `- ${keyMatch[1].trim()}` : `- ${rest.split(":")[0].trim() || rest}`;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const depth = stack.length;
      if (maxDepth !== undefined && depth >= maxDepth) continue;
      entries.push({ depth, kind: "sequence-key", name, line: i + 1, end_line: i + 1 });
      continue;
    }

    // Key: value
    const keyMatch = trimmed.match(/^("?[^":]+"?):\s*(.*)$/);
    if (keyMatch) {
      let key = keyMatch[1].replace(/"/g, "").trim();
      const value = keyMatch[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const depth = stack.length;
      if (maxDepth !== undefined && depth >= maxDepth) continue;
      const kind = value === "" ? "key" : "leaf";
      entries.push({ depth, kind, name: key, line: i + 1, end_line: i + 1 });
      if (value === "") {
        stack.push({ indent: indent + 2, idx: entries.length - 1 });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Source code outline (Rust binary — tree-sitter AST)
// ---------------------------------------------------------------------------

const DEFAULT_BIN = join(homedir(), ".pi", "agent", "bin", "devin-tools-mock");

function binaryPath(): string {
  return process.env.DEVIN_TOOLS_MOCK_BIN || DEFAULT_BIN;
}

function outlineSourceCli(absFilePath: string, maxDepth?: number): OutlineEntry[] | null {
  const bin = binaryPath();
  if (!existsSync(bin)) return null;

  const input: Record<string, unknown> = { file_path: absFilePath };
  if (maxDepth !== undefined) input.max_depth = maxDepth;

  try {
    const stdout = execFileSync(bin, ["outline"], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = JSON.parse(stdout) as { entries: OutlineEntry[] };
    return output.entries;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderOutline(entries: OutlineEntry[]): string {
  return entries
    .map((e) => `${"  ".repeat(e.depth)}${e.kind} ${e.name} [${e.line},${e.end_line}]`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main outline function
// ---------------------------------------------------------------------------

function generateOutline(filePath: string, maxDepth?: number): { kind: string; rendered: string; entryCount: number } {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) throw new Error(`file not found: ${absPath}`);
  if (!statSync(absPath).isFile()) throw new Error(`not a file: ${absPath}`);

  const kind = classify(absPath);
  const raw = readFileSync(absPath, "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let entries: OutlineEntry[];

  switch (kind) {
    case "markdown":
      entries = outlineMarkdown(lines, maxDepth);
      break;
    case "yaml":
      entries = outlineYaml(lines, maxDepth);
      break;
    case "source": {
      const cliEntries = outlineSourceCli(absPath, maxDepth);
      entries = cliEntries ?? [];
      break;
    }
  }

  const rendered =
    entries.length === 0
      ? `outline: no structure detected in ${absPath} (kind=${kind}, ${lines.length} lines).`
      : `outline of ${absPath} (${kind}, ${lines.length} lines, ${entries.length} entries):\n${renderOutline(entries)}`;

  return { kind, rendered, entryCount: entries.length };
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const OutlineParams = Type.Object({
  file_path: Type.String({
    description: "The absolute path to the file to outline. Must be absolute, not relative.",
  }),
  max_depth: Type.Optional(
    Type.Integer({
      description: "Optional maximum nesting depth to include (1 = top-level only). Defaults to unlimited.",
    }),
  ),
});

export default async function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description: [
      "Generates a structural outline of a file (functions, classes, sections,",
      "YAML keys, Markdown headings) with 1-based line ranges. Use this before",
      "reading a large file to locate the exact line range you need, then call",
      "`read` with offset/limit. Supports Markdown (.md), YAML (.yaml/.yml), and",
      "source code (.py, .rs, .ts, .js, .go, .java, .c, .cpp, .h, .rb, .sh, etc.).",
      "The file_path parameter must be an absolute path.",
    ].join(" "),

    parameters: OutlineParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const input = params as { file_path: string; max_depth?: number };
        if (!input?.file_path) {
          return {
            content: [{ type: "text", text: "outline: missing required parameter `file_path`." }],
            isError: true,
          };
        }
        const result = generateOutline(input.file_path, input.max_depth);
        return {
          content: [{ type: "text", text: result.rendered }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: `outline failed: ${err.message || err}`,
          }],
          isError: true,
        };
      }
    },
  });
}
