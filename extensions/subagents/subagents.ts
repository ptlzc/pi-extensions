/**
 * subagents — Configurable multi-subagent extension for Pi
 *
 * Supports two subagent types:
 *   - type: pi  — spawns a pi subprocess with isolated context, specific model/tools/prompt
 *   - type: cli — spawns an external CLI command (e.g. devin, codex, aider)
 *
 * Features:
 *   - Model fallback for pi-type subagents
 *   - Prompt templates (inline or from file)
 *   - Parallel execution
 *   - Template variables in CLI args ({task}, {cwd}, {agent_name})
 *   - Project-level YAML config in .pi/subagents.yaml
 *
 * Config: .pi/subagents.yaml or .pi/subagents.json
 */

import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubagentType = "pi" | "cli";

interface SubagentConfig {
  name: string;
  description: string;
  type: SubagentType;
  // Pi-type
  model?: string;
  fallback_models?: string[];
  tools?: string[];
  system_prompt?: string;
  system_prompt_file?: string;
  max_tokens?: number;
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
    max_tokens?: number;
  };
}

interface SubagentResult {
  agent: string;
  task: string;
  success: boolean;
  output: string;
  error?: string;
  model?: string;
  turns?: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadYaml(): Promise<typeof import("yaml") | null> {
  try {
    return await import("yaml");
  } catch {
    return null;
  }
}

function findConfigFile(cwd: string): string | null {
  // Walk up from cwd looking for .pi/subagents.yaml or .pi/subagents.json
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const yamlPath = join(dir, ".pi", "subagents.yaml");
    const ymlPath = join(dir, ".pi", "subagents.yml");
    const jsonPath = join(dir, ".pi", "subagents.json");
    if (existsSync(yamlPath)) return yamlPath;
    if (existsSync(ymlPath)) return ymlPath;
    if (existsSync(jsonPath)) return jsonPath;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadConfig(cwd: string): Promise<SubagentsConfig> {
  const configPath = findConfigFile(cwd);
  if (!configPath) return { subagents: [] };

  const raw = readFileSync(configPath, "utf-8");

  if (configPath.endsWith(".json")) {
    try {
      return JSON.parse(raw) as SubagentsConfig;
    } catch (err) {
      console.error(`[subagents] Failed to parse ${configPath}: ${err}`);
      return { subagents: [] };
    }
  }

  const yaml = await loadYaml();
  if (!yaml) {
    console.error(
      `[subagents] Found ${configPath} but js-yaml/yaml is not installed. Using JSON config instead.`,
    );
    try {
      return JSON.parse(raw) as SubagentsConfig;
    } catch {
      return { subagents: [] };
    }
  }

  try {
    return yaml.parse(raw) as SubagentsConfig;
  } catch (err) {
    console.error(`[subagents] Failed to parse ${configPath}: ${err}`);
    return { subagents: [] };
  }
}

function resolveSystemPrompt(
  agent: SubagentConfig,
  configPath: string | null,
): string {
  if (agent.system_prompt) {
    return agent.system_prompt;
  }
  if (agent.system_prompt_file) {
    const basePath = configPath ? dirname(configPath) : process.cwd();
    const promptPath = resolve(basePath, agent.system_prompt_file);
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, "utf-8");
    }
    console.error(
      `[subagents] system_prompt_file not found: ${promptPath}`,
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// Template substitution
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
// Pi subagent runner (with model fallback)
// ---------------------------------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
  turns: number;
  stopReason?: string;
  errorMessage?: string;
}

async function runPiOnce(
  agent: SubagentConfig,
  model: string,
  task: string,
  cwd: string,
  systemPrompt: string,
  defaults: { max_tokens?: number },
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<PiRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  args.push("--model", model);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }
  const maxTokens = agent.max_tokens ?? defaults.max_tokens;
  if (maxTokens) {
    args.push("--max-tokens", String(maxTokens));
  }

  let tmpDir: string | null = null;
  if (systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, systemPrompt);
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
      // Process complete JSON lines
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
        model,
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
        model,
        turns: 0,
        errorMessage: err.message,
      });
    });
  });
}

async function runPiSubagent(
  agent: SubagentConfig,
  task: string,
  cwd: string,
  systemPrompt: string,
  defaults: { max_tokens?: number },
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<SubagentResult> {
  const start = Date.now();
  const models = [agent.model, ...(agent.fallback_models ?? [])].filter(
    Boolean,
  ) as string[];

  if (models.length === 0) {
    return {
      agent: agent.name,
      task,
      success: false,
      output: "",
      error: "No model configured for pi-type subagent",
      durationMs: Date.now() - start,
    };
  }

  let lastError = "";
  for (const model of models) {
    const result = await runPiOnce(
      agent,
      model,
      task,
      cwd,
      systemPrompt,
      defaults,
      signal,
      onUpdate,
    );

    const failed =
      result.exitCode !== 0 ||
      result.stopReason === "error" ||
      result.stopReason === "aborted";

    if (!failed) {
      return {
        agent: agent.name,
        task,
        success: true,
        output: result.output || "(no output)",
        model: result.model,
        turns: result.turns,
        durationMs: Date.now() - start,
      };
    }

    lastError =
      result.errorMessage || result.stderr || result.output || "Unknown error";
    console.error(
      `[subagents] Agent "${agent.name}" model "${model}" failed: ${lastError}`,
    );

    if (result.stopReason === "aborted") {
      // User abort — don't try fallback
      break;
    }
  }

  return {
    agent: agent.name,
    task,
    success: false,
    output: "",
    error: `All models failed. Last error: ${lastError}`,
    model: models[models.length - 1],
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// CLI subagent runner
// ---------------------------------------------------------------------------

async function runCliSubagent(
  agent: SubagentConfig,
  task: string,
  cwd: string,
  defaultTimeout: number,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
): Promise<SubagentResult> {
  const start = Date.now();

  if (!agent.command) {
    return {
      agent: agent.name,
      task,
      success: false,
      output: "",
      error: "No command configured for cli-type subagent",
      durationMs: Date.now() - start,
    };
  }

  const timeout = (agent.timeout ?? defaultTimeout) * 1000;
  const agentCwd = agent.cwd ? resolve(cwd, agent.cwd) : cwd;
  const vars = { task, cwd: agentCwd, agent_name: agent.name };
  const args = (agent.args ?? []).map((a) => substituteTemplate(a, vars));

  return new Promise<SubagentResult>((resolve) => {
    const proc = spawn(agent.command!, args, {
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

    const done = (result: SubagentResult) => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    proc.on("close", (code) => {
      const success = code === 0 && !timedOut;
      done({
        agent: agent.name,
        task,
        success,
        output: stdout.trim() || "(no output)",
        error: !success
          ? timedOut
            ? `Timed out after ${timeout / 1000}s`
            : stderr.trim() || `Exit code ${code}`
          : undefined,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      done({
        agent: agent.name,
        task,
        success: false,
        output: "",
        error: err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Parallel execution helper
// ---------------------------------------------------------------------------

async function runParallel(
  items: { agent: string; task: string }[],
  config: SubagentsConfig,
  cwd: string,
  configPath: string | null,
  signal: AbortSignal | undefined,
  onUpdate: ((index: number, text: string) => void) | undefined,
  maxConcurrency = 4,
): Promise<SubagentResult[]> {
  const results = new Array<SubagentResult>(items.length);
  let nextIndex = 0;
  const defaultTimeout = config.defaults?.timeout ?? 120;

  const workers = new Array(Math.min(maxConcurrency, items.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        const { agent: agentName, task } = items[i];
        const agent = config.subagents.find((a) => a.name === agentName);

        if (!agent) {
          results[i] = {
            agent: agentName,
            task,
            success: false,
            output: "",
            error: `Unknown agent: "${agentName}". Available: ${config.subagents.map((a) => a.name).join(", ") || "none"}`,
            durationMs: 0,
          };
          continue;
        }

        const systemPrompt = resolveSystemPrompt(agent, configPath);

        if (agent.type === "cli") {
          results[i] = await runCliSubagent(
            agent,
            task,
            cwd,
            defaultTimeout,
            signal,
            (text) => onUpdate?.(i, text),
          );
        } else {
          results[i] = await runPiSubagent(
            agent,
            task,
            cwd,
            systemPrompt,
            { max_tokens: config.defaults?.max_tokens },
            signal,
            (text) => onUpdate?.(i, text),
          );
        }
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
  const turns = result.turns ? ` ${result.turns} turn${result.turns > 1 ? "s" : ""}` : "";
  const duration = ` ${(result.durationMs / 1000).toFixed(1)}s`;

  if (!result.success) {
    return `${status} ${result.agent}${model}${turns}${duration}\n  Error: ${result.error}`;
  }

  const output =
    result.output.length > 8000
      ? result.output.slice(0, 8000) +
        `\n\n[Output truncated: ${result.output.length - 8000} chars omitted]`
      : result.output;

  return `${status} ${result.agent}${model}${turns}${duration}\n${output}`;
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
      description: "Array of {agent, task} for parallel execution (max 8, 4 concurrent)",
    }),
  ),
});

export default async function (pi: ExtensionAPI) {
  // Preload yaml parser
  await loadYaml();

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Supports pi-type (spawn pi with model/tools/prompt) and cli-type (spawn external command like devin/codex).",
      "Modes: single (agent + task), parallel (tasks array).",
      "Configure subagents in .pi/subagents.yaml.",
    ].join(" "),

    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const configPath = findConfigFile(ctx.cwd);

      if (config.subagents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No subagents configured. Create .pi/subagents.yaml with subagent definitions.\nSee: https://github.com/ptlzc/pi-extensions/tree/main/extensions/subagents",
            },
          ],
        };
      }

      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);

      if (!hasTasks && !hasSingle) {
        const available = config.subagents
          .map(
            (a) =>
              `"${a.name}" (${a.type}${a.model ? `:${a.model}` : ""}): ${a.description}`,
          )
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
          const available = config.subagents.map((a) => `"${a.name}"`).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Unknown subagent: "${agentName}". Available: ${available}`,
              },
            ],
          };
        }

        const systemPrompt = resolveSystemPrompt(agent, configPath);
        const defaultTimeout = config.defaults?.timeout ?? 120;

        let result: SubagentResult;
        if (agent.type === "cli") {
          result = await runCliSubagent(
            agent,
            task,
            ctx.cwd,
            defaultTimeout,
            signal,
            (text) =>
              onUpdate?.({
                content: [{ type: "text", text }],
              }),
          );
        } else {
          result = await runPiSubagent(
            agent,
            task,
            ctx.cwd,
            systemPrompt,
            { max_tokens: config.defaults?.max_tokens },
            signal,
            (text) =>
              onUpdate?.({
                content: [{ type: "text", text }],
              }),
          );
        }

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
      const results = await runParallel(
        tasks,
        config,
        ctx.cwd,
        configPath,
        signal,
        (index, text) => {
          const status = results[index]
            ? results[index].success
              ? "✓"
              : "✗"
            : "⏳";
          onUpdate?.({
            content: [
              {
                type: "text",
                text: tasks
                  .map((t, i) => {
                    const s = results[i]
                      ? results[i].success
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
