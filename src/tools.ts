import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { runScript } from "./python.ts"
import { renderDiagrams } from "./render.ts"
import { formatOutcome, startReview, type ReviewSession } from "./review/server.ts"

export interface ParamSpec {
  type: "string" | "number" | "boolean" | "string[]"
  description: string
  optional?: boolean
  enum?: string[]
}

export interface ToolEnv {
  directory: string
  signal?: AbortSignal
  progress: (status: string) => void
}

export interface ToolSpec {
  name: string
  description: string
  params: Record<string, ParamSpec>
  execute(args: Record<string, any>, env: ToolEnv): Promise<string>
}

const MAX_INLINE_CHARS = 60_000

async function saveLarge(env: ToolEnv, name: string, text: string): Promise<string> {
  const file = path.join(env.directory, ".clean-arch", "cache", name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return path.relative(env.directory, file).split(path.sep).join("/")
}

function repeat(flag: string, values: unknown): string[] {
  return Array.isArray(values) ? values.flatMap((v) => [flag, String(v)]) : []
}

const facts: ToolSpec = {
  name: "clean_arch_facts",
  description:
    "Deterministic architecture facts for a Python (+ small frontend) repository, parsed without importing it: " +
    "modules, package dependencies, import cycles, unresolved internal imports, duplicate code, hotspots, core classes, " +
    "entry points. command=summary (default) for a Markdown overview (brief=true for a metrics table); mermaid for draft " +
    "diagrams (view packages|classes, focus a dotted prefix); importers to list everything that references target " +
    "(imports including tests, plus mentions in scripts, configs, docs, Dockerfiles); check to verify " +
    ".clean-arch/rules.toml; verify to check Mermaid diagrams (.mmd files, or mermaid blocks in .md) against the code; " +
    "json writes full facts to .clean-arch/cache/facts.json.",
  params: {
    command: { type: "string", enum: ["summary", "mermaid", "importers", "check", "verify", "json"], optional: true, description: "default summary" },
    target: { type: "string", optional: true, description: "command=importers: module, package or path (pkg.serving, legacy_agent/); command=verify: diagram file or directory (default docs/architecture/diagrams)" },
    brief: { type: "boolean", optional: true, description: "summary as a short metrics table (for baselines and reports)" },
    include: { type: "string[]", optional: true, description: "only analyse these paths (relative to the project)" },
    view: { type: "string", enum: ["packages", "classes"], optional: true, description: "diagram kind for command=mermaid" },
    focus: { type: "string", optional: true, description: "dotted module prefix to focus a diagram on, e.g. pkg.agent" },
    max_nodes: { type: "number", optional: true, description: "node budget for diagrams (default 15; cycle members are always kept)" },
    depth: { type: "number", optional: true, description: "package collapse depth for package graphs (default 2)" },
    include_tests: { type: "boolean", optional: true, description: "count test modules in graphs and classes" },
    rules: { type: "string", optional: true, description: "rules file for command=check (default .clean-arch/rules.toml)" },
  },
  async execute(args, env) {
    const command = args.command ?? "summary"
    if (command === "importers" && !args.target) throw new Error("command=importers needs target")
    const positional = command === "importers" || (command === "verify" && args.target) ? [args.target] : []
    const argv = [command, ...positional, ...repeat("--include", args.include)]
    if (args.brief) argv.push("--brief")
    if (args.view) argv.push("--view", args.view)
    if (args.focus) argv.push("--focus", args.focus)
    if (args.max_nodes) argv.push("--max-nodes", String(args.max_nodes))
    if (args.depth) argv.push("--depth", String(args.depth))
    if (args.include_tests) argv.push("--include-tests")
    if (args.rules) argv.push("--rules", args.rules)
    env.progress(`clean_arch_facts ${command}`)
    const result = await runScript("arch_facts.py", env.directory, argv, env.signal)
    if (result.code !== 0 && !((command === "check" || command === "verify") && result.code === 1)) {
      throw new Error(`arch_facts.py failed (exit ${result.code}):\n${result.stderr || result.stdout}`)
    }
    if (command === "json" || result.stdout.length > MAX_INLINE_CHARS) {
      const saved = await saveLarge(env, command === "json" ? "facts.json" : `facts-${command}.md`, result.stdout)
      return `Wrote ${result.stdout.length} characters to ${saved}. Read or grep that file for details.`
    }
    return result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")
  },
}

const leftovers: ToolSpec = {
  name: "clean_arch_leftovers",
  description:
    "Scan for what a refactor must not leave behind: parallel versions (foo_v2.py, copied files), duplicate function " +
    "bodies, broken internal imports, compatibility shims (aliases, ImportError fallbacks, deprecation wrappers), " +
    "commented-out code, debug output, *_old/*_new/legacy_* names, narrative comments, unreferenced code, TODOs. " +
    "Use since=<git ref> to limit findings to changed files.",
  params: {
    since: { type: "string", optional: true, description: "only report files changed since this git ref (plus untracked files)" },
    include: { type: "string[]", optional: true, description: "only report findings under these paths" },
    skip: { type: "string[]", optional: true, description: "categories to skip, e.g. todo, unreferenced" },
    limit: { type: "number", optional: true, description: "items shown per category (default 25)" },
  },
  async execute(args, env) {
    const argv = ["--fail-on", "never", ...repeat("--include", args.include), ...repeat("--skip", args.skip)]
    if (args.since) argv.push("--since", args.since)
    if (args.limit) argv.push("--limit", String(args.limit))
    env.progress("clean_arch_leftovers")
    const result = await runScript("leftover_scan.py", env.directory, argv, env.signal)
    if (result.code !== 0) throw new Error(`leftover_scan.py failed (exit ${result.code}):\n${result.stderr || result.stdout}`)
    if (result.stdout.length > MAX_INLINE_CHARS) {
      const saved = await saveLarge(env, "leftovers.md", result.stdout)
      return result.stdout.slice(0, 4000) + `\n…\nFull report (${result.stdout.length} characters) saved to ${saved}.`
    }
    return result.stdout
  },
}

const render: ToolSpec = {
  name: "clean_arch_render",
  description:
    "Render Mermaid diagram sources (*.mmd) to self-contained SVG files next to them, so architecture docs display on " +
    "code hosts that do not render Mermaid (e.g. CodeHub). Pass a directory (all .mmd files below it) or a single file.",
  params: {
    path: { type: "string", optional: true, description: "file or directory, default docs/architecture/diagrams" },
    force: { type: "boolean", optional: true, description: "re-render even when the SVG is newer than its source" },
  },
  async execute(args, env) {
    const target = path.resolve(env.directory, args.path || "docs/architecture/diagrams")
    env.progress("rendering diagrams")
    const result = await renderDiagrams(target, Boolean(args.force))
    const rel = (p: string) => path.relative(env.directory, p).split(path.sep).join("/")
    const lines = [`Rendered ${result.rendered.length}, up to date ${result.skipped.length}, failed ${result.failed.length}.`]
    for (const file of result.rendered) lines.push(`+ ${rel(file)}`)
    for (const { file, error } of result.failed) lines.push(`! ${rel(file)}: ${error}`)
    if (result.failed.length) lines.push("Fix the Mermaid syntax of the failed files (or simplify the diagram) and render again.")
    for (const { file, message } of result.warnings) lines.push(`? ${rel(file)}: ${message}`)
    if (result.warnings.length) lines.push("Rework the diagrams with warnings (`?`) and render again with force.")
    return lines.join("\n")
  },
}

const perf: ToolSpec = {
  name: "clean_arch_perf",
  description:
    "Performance helpers for the perf-tune skill. action=scan (default): static candidates for known slow patterns " +
    "(per-item pyproj Transformer or shapely Point creation, iterrows, np.add.at, array growth in loops, GPU syncs in " +
    "loops, ...), pattern matches that need a profile to confirm. action=env: versions and backends of the " +
    "performance-relevant libraries in a Python environment (protobuf backend, laspy LAZ decoder, OpenMP runtimes, " +
    "thread settings); pass python=<project interpreter>. action=bench: run a shell command repeatedly, report median " +
    "and spread, save it as .clean-arch/perf/bench-<name>.json, and compare with a saved baseline via compare=<name>; " +
    "the command may print lines 'PERF_METRIC name=value' for in-process timings. action=lessons: search the persistent " +
    "store of measured optimization lessons with query, or add one verified lesson with entry.",
  params: {
    action: { type: "string", enum: ["scan", "env", "bench", "lessons"], optional: true, description: "default scan" },
    include: { type: "string[]", optional: true, description: "action=scan: only scan these paths (relative to the project)" },
    include_tests: { type: "boolean", optional: true, description: "action=scan: also scan test files" },
    limit: { type: "number", optional: true, description: "action=scan: locations shown per rule (default 8); action=lessons: max entries (default 8)" },
    python: { type: "string", optional: true, description: "action=env: interpreter of the project environment, e.g. .venv/bin/python (default: the plugin's Python)" },
    name: { type: "string", optional: true, description: "action=bench: name of this benchmark (letters, digits, . _ -)" },
    command: { type: "string", optional: true, description: "action=bench: shell command to time, run from the project root or cwd" },
    runs: { type: "number", optional: true, description: "action=bench: measured runs (default 7, minimum 3)" },
    warmup: { type: "number", optional: true, description: "action=bench: discarded warm-up runs (default 1)" },
    cwd: { type: "string", optional: true, description: "action=bench: working directory relative to the project" },
    compare: { type: "string", optional: true, description: "action=bench: name of a saved benchmark to compare with" },
    threshold: { type: "number", optional: true, description: "action=bench: smallest relative change that counts, default 0.05" },
    query: { type: "string", optional: true, description: "action=lessons: words to search for, e.g. 'shapely contains point'; omit to list the index" },
    entry: { type: "string", optional: true, description: "action=lessons: one Markdown entry to add ('## title' then '- key: value' lines); only for verified, measured results" },
  },
  async execute(args, env) {
    const action = args.action ?? "scan"
    const argv: string[] = [action]
    let timeoutMs = 10 * 60_000
    if (action === "scan") {
      argv.push(...repeat("--include", args.include))
      if (args.include_tests) argv.push("--include-tests")
      if (args.limit) argv.push("--limit", String(args.limit))
    } else if (action === "env") {
      if (args.python) argv.push("--python", path.resolve(env.directory, args.python))
    } else if (action === "bench") {
      if (!args.name || !args.command) throw new Error("action=bench needs name and command")
      argv.push(args.name, "--cmd", args.command)
      if (args.runs) argv.push("--runs", String(args.runs))
      if (args.warmup !== undefined) argv.push("--warmup", String(args.warmup))
      if (args.cwd) argv.push("--cwd", args.cwd)
      if (args.compare) argv.push("--compare", args.compare)
      if (args.threshold) argv.push("--threshold", String(args.threshold))
      timeoutMs = 2 * 60 * 60_000
    } else if (action === "lessons") {
      if (args.query) argv.push("--query", args.query)
      if (args.entry) argv.push("--entry", args.entry)
      if (args.limit) argv.push("--limit", String(args.limit))
    }
    env.progress(`clean_arch_perf ${action}`)
    const result = await runScript("perf_check.py", env.directory, argv, env.signal, timeoutMs)
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim())
    return result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : "")
  },
}

const reviewSessions = new Map<string, ReviewSession>()

const review: ToolSpec = {
  name: "clean_arch_review",
  description:
    "Browser review page for a Markdown document (plan, diagnosis, design doc). The user can select text to comment on, " +
    "delete or replace it, sees a diff against the previous revision, and approves, approves with notes or requests changes. " +
    "Two steps: action=open starts the page and returns its URL immediately (tell the user the URL in your reply, because " +
    "a browser may not open on remote machines); action=wait then blocks until the user decides and returns the decision " +
    "with structured annotations.",
  params: {
    path: { type: "string", description: "Markdown file to review, relative to the project, e.g. .clean-arch/plan.md" },
    action: { type: "string", optional: true, enum: ["open", "wait"], description: "open (default): start the page and return the URL; wait: block until the user decides" },
    title: { type: "string", optional: true, description: "title shown on the page (default: first heading)" },
  },
  async execute(args, env) {
    const key = path.resolve(env.directory, args.path)
    let session = reviewSessions.get(key)
    if (args.action === "wait") {
      if (!session) {
        session = await startReviewSession(key, env, args)
        env.progress(`Waiting for review: ${session.url}`)
      }
      const onAbort = () => session!.cancel()
      env.signal?.addEventListener("abort", onAbort, { once: true })
      if (env.signal?.aborted) onAbort()
      try {
        const outcome = await session.outcome
        return `Review page: ${outcome.url}\n${formatOutcome(outcome)}`
      } finally {
        env.signal?.removeEventListener("abort", onAbort)
      }
    }
    if (session) {
      // A page that was opened but never waited on shows a stale copy of the file.
      session.cancel()
      await session.outcome
    }
    session = await startReviewSession(key, env, args)
    return [
      `Review page is ready: ${session.url}`,
      "",
      "Next: tell the user this URL in your reply (the browser may not have opened, for example on a remote or headless machine),",
      `then call clean_arch_review again with path "${args.path}" and action "wait". Do nothing else until that call returns.`,
    ].join("\n")
  },
}

async function startReviewSession(key: string, env: ToolEnv, args: Record<string, any>): Promise<ReviewSession> {
  const session = await startReview({ root: env.directory, file: args.path, title: args.title })
  reviewSessions.set(key, session)
  void session.outcome.then(
    () => reviewSessions.delete(key),
    () => reviewSessions.delete(key),
  )
  return session
}

export const TOOLS: ToolSpec[] = [facts, leftovers, render, review, perf]

export function toJsonSchema(params: Record<string, ParamSpec>) {
  const properties: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(params)) {
    const base =
      spec.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: spec.type, ...(spec.enum ? { enum: spec.enum } : {}) }
    properties[name] = { ...base, description: spec.description }
  }
  const required = Object.entries(params)
    .filter(([, spec]) => !spec.optional)
    .map(([name]) => name)
  return { type: "object", properties, required, additionalProperties: false }
}

export function toZodShape(z: any, params: Record<string, ParamSpec>) {
  const shape: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(params)) {
    let field =
      spec.type === "string[]"
        ? z.array(z.string())
        : spec.enum
          ? z.enum(spec.enum)
          : spec.type === "number"
            ? z.number()
            : spec.type === "boolean"
              ? z.boolean()
              : z.string()
    field = field.describe(spec.description)
    shape[name] = spec.optional ? field.optional() : field
  }
  return shape
}
