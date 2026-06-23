/**
 * outline — Structural outline tool for Pi
 *
 * Generates file structure outlines (functions, classes, sections with line
 * numbers) to enable precise line-range reads instead of whole-file reads.
 *
 * Two paths:
 *   - Markdown (.md, .markdown, .md.j2, .j2): regex-based heading parser
 *   - Source code: codegraph SDK (tree-sitter WASM) via extractFromSource
 *
 * Recommended first step for files >200 lines.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Markdown outline (pure regex, no deps)
// ---------------------------------------------------------------------------

const HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface MdHeading {
  level: number;
  title: string;
  line: number;
  endLine: number;
  children: MdHeading[];
}

function parseMarkdownHeadings(lines: string[]): MdHeading[] {
  const roots: MdHeading[] = [];
  const stack: MdHeading[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const total = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, "");
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
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    if (inFence) continue;

    const match = line.match(HEADING_RE);
    if (!match) continue;

    const level = match[2].length;
    let title = match[3].trim();
    // Strip trailing # marks
    title = title.replace(/[ \t]+#{1,}[ \t]*$/, "").trim();

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack[stack.length - 1].endLine = i;
      stack.pop();
    }

    const heading: MdHeading = {
      level,
      title,
      line: i + 1,
      endLine: total,
      children: [],
    };

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(heading);
    } else {
      roots.push(heading);
    }
    stack.push(heading);
  }

  for (const h of stack) h.endLine = total;
  return roots;
}

function renderMarkdownOutline(headings: MdHeading[], depth = 0): string[] {
  const rows: string[] = [];
  const prefix = "  ".repeat(depth);
  for (const h of headings) {
    const marks = "#".repeat(h.level);
    rows.push(`${prefix}${marks} ${h.title} [${h.line},${h.endLine}]`);
    rows.push(...renderMarkdownOutline(h.children, depth + 1));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Source code outline (codegraph SDK)
// ---------------------------------------------------------------------------

const MARKDOWN_EXTS = new Set([
  ".md", ".markdown", ".md.j2", ".markdown.j2", ".j2",
]);

// Source kinds we care about (subset of codegraph NODE_KINDS)
const SOURCE_KINDS = new Set([
  "class", "component", "enum", "function", "interface", "method",
  "module", "namespace", "protocol", "record", "route", "struct",
  "trait", "type_alias",
]);

// Lazy-loaded codegraph SDK
let cgSdk: any = null;
let cgInitPromise: Promise<any> | null = null;

async function getCodegraphSdk(): Promise<any> {
  if (cgSdk) return cgSdk;
  if (cgInitPromise) return cgInitPromise;

  cgInitPromise = (async () => {
    const mod = await import("@colbymchenry/codegraph");
    cgSdk = mod.default || mod;
    return cgSdk;
  })();

  return cgInitPromise;
}

interface SourceNode {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  children: SourceNode[];
}

function buildSourceHierarchy(
  rawNodes: any[],
  relPath: string,
): SourceNode[] {
  // Filter to relevant kinds in this file
  const candidates = rawNodes
    .filter((n) =>
      SOURCE_KINDS.has(n.kind) &&
      typeof n.startLine === "number" &&
      typeof n.endLine === "number" &&
      typeof n.name === "string" &&
      (n.filePath === relPath || n.path === relPath || !n.filePath),
    )
    .sort((a, b) => {
      const startDiff = a.startLine - b.startLine;
      if (startDiff !== 0) return startDiff;
      return (b.endLine - b.startLine) - (a.endLine - a.startLine);
    });

  const roots: SourceNode[] = [];
  const stack: SourceNode[] = [];

  for (const raw of candidates) {
    const start = raw.startLine;
    const end = Math.max(raw.endLine, start);
    const node: SourceNode = {
      kind: raw.kind,
      name: raw.name,
      startLine: start,
      endLine: end,
      children: [],
    };

    while (stack.length > 0 && !contains(stack[stack.length - 1], node)) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  return roots;
}

function contains(parent: SourceNode, child: SourceNode): boolean {
  return (
    parent.startLine <= child.startLine &&
    parent.endLine >= child.endLine &&
    (parent.startLine !== child.startLine || parent.endLine !== child.endLine)
  );
}

function renderSourceOutline(nodes: SourceNode[], depth = 0): string[] {
  const rows: string[] = [];
  const prefix = "  ".repeat(depth);
  for (const n of nodes) {
    rows.push(`${prefix}${n.kind} ${n.name} [${n.startLine},${n.endLine}]`);
    if (n.children.length > 0) {
      rows.push(...renderSourceOutline(n.children, depth + 1));
    }
  }
  return rows;
}

function findProjectRoot(filePath: string): string {
  const { dirname } = require("node:path");
  const { existsSync } = require("node:fs");
  let dir = dirname(resolve(filePath));
  const segments = dir.split("/");
  while (segments.length > 1) {
    const current = segments.join("/");
    if (
      existsSync(current + "/.git") ||
      existsSync(current + "/.se") ||
      existsSync(current + "/.codegraph")
    ) {
      return current;
    }
    segments.pop();
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Main outline function
// ---------------------------------------------------------------------------

async function generateOutline(filePath: string): Promise<string> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    throw new Error(`file not found: ${absPath}`);
  }
  if (!statSync(absPath).isFile()) {
    throw new Error(`not a file: ${absPath}`);
  }

  const ext = extname(absPath).toLowerCase();
  const isMarkdown = MARKDOWN_EXTS.has(ext) ||
    absPath.endsWith(".md.j2") ||
    absPath.endsWith(".markdown.j2");

  if (isMarkdown) {
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const headings = parseMarkdownHeadings(lines);
    const rows = [`file ${absPath}`, ...renderMarkdownOutline(headings)];
    return rows.filter((r) => r).join("\n");
  }

  // Source code: use codegraph SDK
  const sdk = await getCodegraphSdk();
  const projectRoot = findProjectRoot(absPath);

  // Compute relative path
  const relPath = absPath.startsWith(projectRoot + "/")
    ? absPath.slice(projectRoot.length + 1)
    : basename(absPath);

  // Detect language
  const lang = sdk.detectLanguage(relPath);
  if (!lang || !sdk.isLanguageSupported(lang)) {
    throw new Error(
      `unsupported language for ${relPath} (detected: ${lang || "none"}). ` +
      `Supported: ${sdk.getSupportedLanguages().join(", ")}`,
    );
  }

  // Initialize grammar runtime + load specific language grammar
  await sdk.initGrammars();
  if (!sdk.isGrammarLoaded(lang)) {
    await sdk.loadGrammarsForLanguages([lang]);
  }

  // Read source
  const src = readFileSync(absPath, "utf-8");

  // Set codegraph dir
  const codegraphDir =
    existsSync(projectRoot + "/.se") ? ".se" :
    existsSync(projectRoot + "/.codegraph") ? ".codegraph" : ".se";
  process.env.CODEGRAPH_DIR = codegraphDir;

  // Get or create CodeGraph instance
  let cg: any;
  try {
    if (sdk.CodeGraph.isInitialized(projectRoot)) {
      cg = sdk.CodeGraph.openSync(projectRoot);
    } else {
      cg = sdk.CodeGraph.initSync(projectRoot);
    }
  } catch {
    // Stale DB — remove and reinit
    try {
      const dbFile = projectRoot + "/" + codegraphDir + "/codegraph.db";
      const fs = require("node:fs");
      fs.rmSync(dbFile, { force: true });
    } catch {}
    cg = sdk.CodeGraph.initSync(projectRoot);
  }

  try {
    const result = cg.extractFromSource(relPath, src);
    const rawNodes = Array.isArray(result.nodes) ? result.nodes : [];

    if (rawNodes.length === 0) {
      const errors = Array.isArray(result.errors) ? result.errors : [];
      if (errors.length > 0) {
        const firstErr = errors[0];
        const msg = typeof firstErr === "object" ? firstErr.message : String(firstErr);
        throw new Error(`codegraph parse error: ${msg}`);
      }
      // No nodes and no errors — return minimal outline
      return `file ${absPath}\n(no structural elements found)`;
    }

    const hierarchy = buildSourceHierarchy(rawNodes, relPath);
    if (hierarchy.length === 0) {
      return `file ${absPath}\n(no functions/classes/interfaces found)`;
    }

    const rows = [`file ${absPath}`, ...renderSourceOutline(hierarchy)];
    return rows.filter((r) => r).join("\n");
  } finally {
    cg.close();
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const OutlineParams = Type.Object({
  file: Type.String({
    description: "Absolute or relative path to the file to outline.",
  }),
});

export default async function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "outline",
    label: "Outline",
    description: [
      "Generate a structural outline of a file (functions, classes, sections with line numbers).",
      "Recommended first step before reading files >200 lines — use the outline to identify exact line ranges, then read only those ranges.",
      "Markdown (.md/.j2): heading hierarchy with line ranges.",
      "Source code: codegraph SDK (tree-sitter) — supports TypeScript, JavaScript, Python, Go, Rust, Java, C#, C/C++, Ruby, Swift, Kotlin, and more.",
      "Output format: 'kind name [startLine,endLine]' with indentation for nesting.",
    ].join(" "),

    parameters: OutlineParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.file);

      try {
        const outline = await generateOutline(filePath);
        return {
          content: [{ type: "text", text: outline }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: `outline error: ${err.message || err}\n\nTip: use native read with offset/limit for small files or unsupported file types.`,
          }],
          isError: true,
        };
      }
    },
  });
}
