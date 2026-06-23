/**
 * subagents — Configurable multi-subagent extension for Pi
 *
 * Features:
 *   - Two subagent types: pi (isolated pi subprocess) and cli (external command)
 *   - Fallback = complete subagent definitions (not just models)
 *   - Prompt files: .md (plain) or .j2 (Jinja2 with input validation)
 *   - Template variables in CLI args: {task}, {cwd}, {agent_name}
 *   - Parallel execution (max 8, 4 concurrent)
 *   - Thinking level support for pi-type
 *   - Project-level config in .pi/subagents/config.yaml
 *
 * Config directory: .pi/subagents/
 *   ├── config.yaml
 *   └── prompts/
 *       ├── scout.md
 *       └── reviewer.j2
 */

import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubagentType = "pi" | "cli";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface J2InputSpec {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  default?: unknown;
}

interface SubagentConfig {
  name: string;
  description: string;
  type: SubagentType;

  // Prompt
  prompt?: string; // inline text or file path relative to .pi/subagents/
  prompt_input?: Record<string, unknown>; // input for j2 rendering

  // Pi-type
  model?: string;
  thinking?: ThinkingLevel;
  max_context?: number;
  tools?: string[];
  skills?: string[]; // skill file paths to load via --skill

  // CLI-type
  command?: string;
  args?: string[];
  timeout?: number;
  cwd?: string;

  // Fallback = complete subagent definitions
  fallback?: FallbackConfig[];
}

interface FallbackConfig {
  type: SubagentType;
  // Pi-type
  model?: string;
  thinking?: ThinkingLevel;
  max_context?: number;
  tools?: string[];
  skills?: string[];
  prompt?: string;
  prompt_input?: Record<string, unknown>;
  // CLI-type
  command?: string;
  args?: string[];
  timeout?: number;
  cwd?: string;
}

interface SubagentsConfig {
  subagents: SubagentConfig[];
  defaults?: {
    timeout?: number;
    thinking?: ThinkingLevel;
    skills?: string[];
  };
}

interface SubagentRuntime {
  type: SubagentType;
  model?: string;
  thinking?: ThinkingLevel;
  max_context?: number;
  tools?: string[];
  skills?: string[];
  systemPrompt: string;
  command?: string;
  args?: string[];
  timeout?: number;
  cwd?: string;
}

interface SubagentResult {
  agent: string;
  task: string;
  success: boolean;
  output: string;
  error?: string;
  model?: string;
  thinking?: ThinkingLevel;
  turns?: number;
  durationMs: number;
  attempt: number;
  totalAttempts: number;
}

// ---------------------------------------------------------------------------
// Config directory discovery
// ---------------------------------------------------------------------------

function findSubagentsDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, ".pi", "subagents");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findConfigFile(subagentsDir: string): string | null {
  for (const name of ["config.yaml", "config.yml", "config.json"]) {
    const p = join(subagentsDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// YAML loading
// ---------------------------------------------------------------------------

let yamlModule: typeof import("yaml") | null | undefined;

async function getYaml(): Promise<typeof import("yaml") | null> {
  if (yamlModule !== undefined) return yamlModule;
  try {
    yamlModule = await import("yaml");
  } catch {
    yamlModule = null;
  }
  return yamlModule;
}

let nunjucksModule: typeof import("nunjucks") | null | undefined;

async function getNunjucks(): Promise<typeof import("nunjucks") | null> {
  if (nunjucksModule !== undefined) return nunjucksModule;
  try {
    nunjucksModule = await import("nunjucks");
  } catch {
    nunjucksModule = null;
  }
  return nunjucksModule;
}

async function loadConfig(
  subagentsDir: string,
  configPath: string,
): Promise<SubagentsConfig> {
  const raw = readFileSync(configPath, "utf-8");

  if (configPath.endsWith(".json")) {
    try {
      return JSON.parse(raw) as SubagentsConfig;
    } catch (err) {
      console.error(`[subagents] Failed to parse ${configPath}: ${err}`);
      return { subagents: [] };
    }
  }

  const yaml = await getYaml();
  if (!yaml) {
    console.error(
      `[subagents] Found ${configPath} but yaml package is not installed.`,
    );
    return { subagents: [] };
  }

  try {
    return yaml.parse(raw) as SubagentsConfig;
  } catch (err) {
    console.error(`[subagents] Failed to parse ${configPath}: ${err}`);
    return { subagents: [] };
  }
}

// ---------------------------------------------------------------------------
// Prompt loading and Jinja2 rendering
// ---------------------------------------------------------------------------

interface ParsedJ2Template {
  inputs: J2InputSpec[];
  template: string;
}

function parseJ2Frontmatter(content: string): ParsedJ2Template {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    // No frontmatter — treat entire content as template, no input validation
    return { inputs: [], template: content };
  }

  const frontmatterRaw = match[1];
  const template = match[2];
  const inputs: J2InputSpec[] = [];

  // Parse simple YAML-like frontmatter for inputs
  const yaml = getYamlSync();
  if (yaml) {
    try {
      const fm = yaml.parse(frontmatterRaw) as Record<string, unknown>;
      if (fm.inputs && Array.isArray(fm.inputs)) {
        for (const inp of fm.inputs as Record<string, unknown>[]) {
          if (inp.name && inp.type) {
            inputs.push({
              name: String(inp.name),
              type: inp.type as J2InputSpec["type"],
              required: inp.required as boolean | undefined,
              default: inp.default,
            });
          }
        }
      }
    } catch {
      // Fall through to empty inputs
    }
  }

  return { inputs, template };
}

let yamlSync: typeof import("yaml") | null | undefined;

function getYamlSync(): typeof import("yaml") | null {
  if (yamlSync !== undefined) return yamlSync;
  try {
    // require() for sync access
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    yamlSync = require("yaml");
  } catch {
    yamlSync = null;
  }
  return yamlSync;
}

function validatePromptInput(
  inputs: J2InputSpec[],
  provided: Record<string, unknown> | undefined,
  agentName: string,
): string[] {
  const errors: string[] = [];
  const providedMap = provided ?? {};

  for (const spec of inputs) {
    const value = providedMap[spec.name];

    if (value === undefined || value === null) {
      if (spec.required && spec.default === undefined) {
        errors.push(
          `[subagents] Agent "${agentName}": missing required input "${spec.name}" (type: ${spec.type})`,
        );
      }
      continue;
    }

    // Type validation
    const actualType = Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value;

    if (actualType !== spec.type) {
      errors.push(
        `[subagents] Agent "${agentName}": input "${spec.name}" expected type "${spec.type}", got "${actualType}"`,
      );
    }
  }

  return errors;
}

function applyDefaults(
  inputs: J2InputSpec[],
  provided: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result = { ...(provided ?? {}) };
  for (const spec of inputs) {
    if (
      (result[spec.name] === undefined || result[spec.name] === null) &&
      spec.default !== undefined
    ) {
      result[spec.name] = spec.default;
    }
  }
  return result;
}

async function renderJ2Template(
  template: string,
  input: Record<string, unknown>,
  agentName: string,
): Promise<string> {
  const nunjucks = await getNunjucks();
  if (!nunjucks) {
    console.error(
      `[subagents] Agent "${agentName}": .j2 prompt requires nunjucks package. Install with: npm i nunjucks`,
    );
    // Fall back to raw template (variables will be undefined)
    return template;
  }

  try {
    return nunjucks.renderString(template, input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[subagents] Agent "${agentName}": Jinja2 render error: ${msg}`,
    );
    return template;
  }
}

async function resolvePrompt(
  promptConfig: string | undefined,
  promptInput: Record<string, unknown> | undefined,
  subagentsDir: string,
  agentName: string,
): Promise<string> {
  if (!promptConfig) {
    return "";
  }

  // Check if it's a file path (relative to .pi/subagents/)
  const promptPath = resolve(subagentsDir, promptConfig);
  let content: string;
  let isFile = false;

  if (existsSync(promptPath) && statSync(promptPath).isFile()) {
    content = readFileSync(promptPath, "utf-8");
    isFile = true;
  } else {
    // Treat as inline prompt text
    content = promptConfig;
  }

  // Determine if it's a .j2 template
  const isJ2 = isFile && extname(promptPath) === ".j2";

  if (!isJ2) {
    // Plain markdown — return as-is
    return content;
  }

  // Parse j2 frontmatter and validate input
  const { inputs, template } = parseJ2Frontmatter(content);

  if (inputs.length > 0) {
    const errors = validatePromptInput(inputs, promptInput, agentName);
    if (errors.length > 0) {
      for (const e of errors) console.error(e);
      // Still try to render with what we have
    }
  }

  const inputWithDefaults = applyDefaults(inputs, promptInput);
  return renderJ2Template(template, inputWithDefaults, agentName);
}

// ---------------------------------------------------------------------------
// Template substitution for CLI args
// ---------------------------------------------------------------------------

function substituteTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build runtime config from SubagentConfig or FallbackConfig
// ---------------------------------------------------------------------------

async function buildRuntime(
  config: SubagentConfig | FallbackConfig,
  name: string,
  subagentsDir: string,
  defaults: { timeout?: number; thinking?: ThinkingLevel; skills?: string[] },
): Promise<SubagentRuntime> {
  const prompt = await resolvePrompt(
    config.prompt,
    config.prompt_input,
    subagentsDir,
    name,
  );

  // Merge skills: config-level skills + defaults-level skills (deduped)
  const configSkills = config.skills ?? [];
  const defaultSkills = defaults.skills ?? [];
  const skills = [...new Set([...configSkills, ...defaultSkills])];

  return {
    type: config.type,
    model: config.model,
    thinking: config.thinking ?? defaults.thinking,
    max_context: config.max_context,
    tools: config.tools,
    skills: skills.length > 0 ? skills : undefined,
    systemPrompt: prompt,
    command: config.command,
    args: config.args,
    timeout: config.timeout,
    cwd: config.cwd,
  };
}

// ---------------------------------------------------------------------------
// Pi subagent runner
// ---------------------------------------------------------------------------

function getPiInvocation(
  args: string[],
): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = join(dir, `prompt-${safeName}.md`);
  writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

interface PiRunResult {
  exitCode: number;
  output: string;
  stderr: string;
  model: string;
  thinking?: ThinkingLevel;
  turns: number;
  stopReason?: string;
  errorMessage?: string;
}

async function runPiOnce(
  runtime: SubagentRuntime,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<PiRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (runtime.model) {
    // Support "provider/model:thinking" syntax
    const thinkingSuffix = runtime.thinking && runtime.thinking !== "off"
      ? `:${runtime.thinking}`
      : "";
    args.push("--model", `${runtime.model}${thinkingSuffix}`);
  } else if (runtime.thinking && runtime.thinking !== "off") {
    args.push("--thinking", runtime.thinking);
  }

  if (runtime.tools && runtime.tools.length > 0) {
    args.push("--tools", runtime.tools.join(","));
  }

  // Load skill files via --skill (can be used multiple times)
  if (runtime.skills && runtime.skills.length > 0) {
    for (const skillPath of runtime.skills) {
      args.push("--skill", skillPath);
    }
  }

  let tmpDir: string | null = null;
  if (runtime.systemPrompt.trim()) {
    const tmp = writePromptToTempFile("subagent", runtime.systemPrompt);
    tmpDir = tmp.dir;
    args.push("--append-system-prompt", tmp.filePath);
  }

  args.push(`Task: ${task}`);

  return new Promise<PiRunResult>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastAssistantText = "";
    let turns = 0;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    const cleanup = () => {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            const msg = event.message;
            if (msg.role === "assistant") {
              turns++;
              stopReason = msg.stopReason;
              for (const part of msg.content) {
                if (part.type === "text") {
                  lastAssistantText = part.text;
                  onUpdate?.(lastAssistantText);
                }
              }
              if (msg.stopReason === "error" && msg.error) {
                errorMessage = msg.error;
              }
            }
          }
        } catch {}
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      resolve({
        exitCode: code ?? 1,
        output: lastAssistantText,
        stderr,
        model: runtime.model ?? "default",
        thinking: runtime.thinking,
        turns,
        stopReason,
        errorMessage,
      });
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      cleanup();
      resolve({
        exitCode: 1,
        output: "",
        stderr: err.message,
        model: runtime.model ?? "default",
        thinking: runtime.thinking,
        turns: 0,
        errorMessage: err.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI subagent runner
// ---------------------------------------------------------------------------

async function runCliOnce(
  runtime: SubagentRuntime,
  task: string,
  cwd: string,
  defaultTimeout: number,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<PiRunResult> {
  if (!runtime.command) {
    return {
      exitCode: 1,
      output: "",
      stderr: "No command configured",
      model: "cli",
      turns: 0,
      errorMessage: "No command configured for cli-type subagent",
    };
  }

  const timeout = (runtime.timeout ?? defaultTimeout) * 1000;
  const agentCwd = runtime.cwd ? resolve(cwd, runtime.cwd) : cwd;
  const vars = { task, cwd: agentCwd, agent_name: "subagent" };
  const args = (runtime.args ?? []).map((a) =>
    substituteTemplate(a, vars),
  );

  return new Promise<PiRunResult>((resolve) => {
    const proc = spawn(runtime.command!, args, {
      cwd: agentCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGTERM");
        } catch {}
      }, timeout);
    }

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onUpdate?.(stdout.trim());
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const done = (result: PiRunResult) => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    proc.on("close", (code) => {
      const failed = code !== 0 || timedOut;
      done({
        exitCode: code ?? 1,
        output: stdout.trim() || "(no output)",
        stderr,
        model: "cli",
        turns: 0,
        stopReason: failed ? (timedOut ? "timeout" : "error") : undefined,
        errorMessage: failed
          ? timedOut
            ? `Timed out after ${timeout / 1000}s`
            : stderr.trim() || `Exit code ${code}`
          : undefined,
      });
    });

    proc.on("error", (err) => {
      done({
        exitCode: 1,
        output: "",
        stderr: err.message,
        model: "cli",
        turns: 0,
        errorMessage: err.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run with fallback chain
// ---------------------------------------------------------------------------

async function runWithFallback(
  primary: SubagentRuntime,
  fallbacks: SubagentRuntime[],
  agentName: string,
  task: string,
  cwd: string,
  defaultTimeout: number,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<SubagentResult> {
  const start = Date.now();
  const allRuntimes = [primary, ...fallbacks];
  let lastError = "";

  for (let i = 0; i < allRuntimes.length; i++) {
    const rt = allRuntimes[i];
    const isLast = i === allRuntimes.length - 1;

    let result: PiRunResult;
    if (rt.type === "cli") {
      result = await runCliOnce(
        rt,
        task,
        cwd,
        defaultTimeout,
        signal,
        onUpdate,
      );
    } else {
      result = await runPiOnce(rt, task, cwd, signal, onUpdate);
    }

    const failed =
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "timeout" ||
      result.stopReason === "aborted";

    if (!failed) {
      return {
        agent: agentName,
        task,
        success: true,
        output: result.output || "(no output)",
        model: result.model,
        thinking: result.thinking,
        turns: result.turns,
        durationMs: Date.now() - start,
        attempt: i + 1,
        totalAttempts: allRuntimes.length,
      };
    }

    lastError =
      result.errorMessage || result.stderr || result.output || "Unknown error";

    const attemptDesc =
      i === 0
        ? `primary (${rt.type}${rt.model ? `:${rt.model}` : ""})`
        : `fallback ${i} (${rt.type}${rt.model ? `:${rt.model}` : rt.command ? `:${rt.command}` : ""})`;
    console.error(
      `[subagents] Agent "${agentName}" ${attemptDesc} failed: ${lastError}`,
    );

    if (result.stopReason === "aborted") {
      // User abort — don't try fallback
      break;
    }

    if (isLast) {
      // No more fallbacks
      break;
    }
  }

  return {
    agent: agentName,
    task,
    success: false,
    output: "",
    error: `All ${allRuntimes.length} attempt(s) failed. Last error: ${lastError}`,
    model: allRuntimes[allRuntimes.length - 1].model,
    thinking: allRuntimes[allRuntimes.length - 1].thinking,
    durationMs: Date.now() - start,
    attempt: allRuntimes.length,
    totalAttempts: allRuntimes.length,
  };
}

// ---------------------------------------------------------------------------
// Parallel execution
// ---------------------------------------------------------------------------

async function runParallel(
  items: { agent: string; task: string }[],
  config: SubagentsConfig,
  subagentsDir: string,
  defaults: { timeout?: number; thinking?: ThinkingLevel; skills?: string[] },
  signal: AbortSignal | undefined,
  onUpdate: ((index: number, text: string) => void) | undefined,
  onComplete:
    | ((index: number, result: SubagentResult) => void)
    | undefined,
  maxConcurrency = 4,
): Promise<SubagentResult[]> {
  const results = new Array<SubagentResult>(items.length);
  let nextIndex = 0;
  const defaultTimeout = defaults.timeout ?? 120;

  // Pre-build runtimes for all agents
  const runtimeCache = new Map<
    string,
    { primary: SubagentRuntime; fallbacks: SubagentRuntime[] }
  >();

  for (const item of items) {
    if (runtimeCache.has(item.agent)) continue;
    const agent = config.subagents.find((a) => a.name === item.agent);
    if (!agent) continue;
    const primary = await buildRuntime(
      agent,
      agent.name,
      subagentsDir,
      defaults,
    );
    const fallbacks: SubagentRuntime[] = [];
    for (const fb of agent.fallback ?? []) {
      fallbacks.push(
        await buildRuntime(fb, agent.name, subagentsDir, defaults),
      );
    }
    runtimeCache.set(item.agent, { primary, fallbacks });
  }

  const workers = new Array(Math.min(maxConcurrency, items.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        const { agent: agentName, task } = items[i];

        const cached = runtimeCache.get(agentName);
        if (!cached) {
          results[i] = {
            agent: agentName,
            task,
            success: false,
            output: "",
            error: `Unknown agent: "${agentName}". Available: ${config.subagents.map((a) => a.name).join(", ") || "none"}`,
            durationMs: 0,
            attempt: 0,
            totalAttempts: 0,
          };
          onComplete?.(i, results[i]);
          continue;
        }

        results[i] = await runWithFallback(
          cached.primary,
          cached.fallbacks,
          agentName,
          task,
          process.cwd(),
          defaultTimeout,
          signal,
          (text) => onUpdate?.(i, text),
        );
        onComplete?.(i, results[i]);
      }
    });

  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(result: SubagentResult): string {
  const status = result.success ? "✓" : "✗";
  const model = result.model ? ` [${result.model}]` : "";
  const thinking = result.thinking && result.thinking !== "off"
    ? ` thinking:${result.thinking}`
    : "";
  const turns = result.turns
    ? ` ${result.turns} turn${result.turns > 1 ? "s" : ""}`
    : "";
  const duration = ` ${(result.durationMs / 1000).toFixed(1)}s`;
  const attempts =
    result.totalAttempts > 1
      ? ` ${result.attempt}/${result.totalAttempts} attempts`
      : "";

  if (!result.success) {
    return `${status} ${result.agent}${model}${thinking}${turns}${duration}${attempts}\n  Error: ${result.error}`;
  }

  const output =
    result.output.length > 8000
      ? result.output.slice(0, 8000) +
        `\n\n[Output truncated: ${result.output.length - 8000} chars omitted]`
      : result.output;

  return `${status} ${result.agent}${model}${thinking}${turns}${duration}${attempts}\n${output}`;
}

function formatResults(results: SubagentResult[]): string {
  if (results.length === 1) {
    return formatResult(results[0]);
  }
  return results.map((r) => formatResult(r)).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the subagent to invoke" }),
  task: Type.String({ description: "Task to delegate to the subagent" }),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Name of the subagent (for single mode)",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description: "Task to delegate (for single mode)",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "Array of {agent, task} for parallel execution (max 8, 4 concurrent)",
    }),
  ),
});

export default async function (pi: ExtensionAPI) {
  // Preload yaml and nunjucks
  await getYaml();
  await getNunjucks();

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Supports pi-type (spawn pi with model/thinking/tools/prompt) and cli-type (spawn external command like devin/codex).",
      "Each subagent can have fallback subagents (complete definitions, not just models).",
      "Prompt files: .md (plain) or .j2 (Jinja2 with input validation).",
      "Modes: single (agent + task), parallel (tasks array).",
      "Configure in .pi/subagents/config.yaml.",
    ].join(" "),

    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const subagentsDir = findSubagentsDir(ctx.cwd);

      if (!subagentsDir) {
        return {
          content: [
            {
              type: "text",
              text: "No subagents directory found. Create .pi/subagents/config.yaml with subagent definitions.\nSee: https://github.com/ptlzc/pi-extensions/tree/main/extensions/subagents",
            },
          ],
        };
      }

      const configPath = findConfigFile(subagentsDir);
      if (!configPath) {
        return {
          content: [
            {
              type: "text",
              text: `Found ${subagentsDir} but no config.yaml/config.json. Create .pi/subagents/config.yaml.\nSee: https://github.com/ptlzc/pi-extensions/tree/main/extensions/subagents`,
            },
          ],
        };
      }

      const config = await loadConfig(subagentsDir, configPath);
      const defaults = {
        timeout: config.defaults?.timeout ?? 120,
        thinking: config.defaults?.thinking,
        skills: config.defaults?.skills,
      };

      if (config.subagents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No subagents configured in ${configPath}.`,
            },
          ],
        };
      }

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);

      if (!hasTasks && !hasSingle) {
        const available = config.subagents
          .map((a) => {
            const parts = [a.type];
            if (a.model) parts.push(a.model);
            if (a.thinking && a.thinking !== "off") parts.push(`thinking:${a.thinking}`);
            const fbCount = a.fallback?.length ?? 0;
            if (fbCount > 0) parts.push(`${fbCount} fallback(s)`);
            return `"${a.name}" (${parts.join(", ")}): ${a.description}`;
          })
          .join("\n  ");
        return {
          content: [
            {
              type: "text",
              text: `Provide either {agent, task} for single mode or {tasks: [...]} for parallel mode.\nAvailable subagents:\n  ${available}`,
            },
          ],
        };
      }

      // Single mode
      if (hasSingle) {
        const agentName = params.agent!;
        const task = params.task!;
        const agent = config.subagents.find((a) => a.name === agentName);

        if (!agent) {
          const available =
            config.subagents.map((a) => `"${a.name}"`).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Unknown subagent: "${agentName}". Available: ${available}`,
              },
            ],
          };
        }

        const primary = await buildRuntime(
          agent,
          agent.name,
          subagentsDir,
          defaults,
        );
        const fallbacks: SubagentRuntime[] = [];
        for (const fb of agent.fallback ?? []) {
          fallbacks.push(
            await buildRuntime(fb, agent.name, subagentsDir, defaults),
          );
        }

        const result = await runWithFallback(
          primary,
          fallbacks,
          agentName,
          task,
          ctx.cwd,
          defaults.timeout ?? 120,
          signal,
          (text) =>
            onUpdate?.({
              content: [{ type: "text", text }],
            }),
        );

        return {
          content: [
            {
              type: "text",
              text: formatResult(result),
            },
          ],
        };
      }

      // Parallel mode
      const tasks = params.tasks!.slice(0, 8);
      const progress: (SubagentResult | undefined)[] = new Array(
        tasks.length,
      ).fill(undefined);
      const results = await runParallel(
        tasks,
        config,
        subagentsDir,
        defaults,
        signal,
        (index, text) => {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: tasks
                  .map((t, i) => {
                    const r = progress[i];
                    const s = r
                      ? r.success
                        ? "✓"
                        : "✗"
                      : i === index
                        ? "⏳"
                        : "...";
                    return `${s} ${t.agent}: ${t.task}`;
                  })
                  .join("\n"),
              },
            ],
          });
        },
        (index, result) => {
          progress[index] = result;
        },
      );

      return {
        content: [
          {
            type: "text",
            text: formatResults(results),
          },
        ],
      };
    },
  });
}
