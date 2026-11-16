import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { diffLines } from "./diff.ts"
import { renderMarkdown } from "./markdown.ts"
import { renderPage, type PageData } from "./page.ts"
import type { Annotation, Decision, ReviewOutcome } from "./types.ts"

export interface ReviewOptions {
  /** Project root; the reviewed file and served images must be inside it. */
  root: string
  /** Markdown file to review, absolute or relative to `root`. */
  file: string
  title?: string
  host?: string
  port?: number
  timeoutMs?: number
  openBrowser?: boolean
  signal?: AbortSignal
  onReady?: (url: string) => void
}

const DECISIONS: Decision[] = ["approved", "approved_with_notes", "changes_requested"]
const IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function reviewSettingsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const minutes = Number(env.CLEAN_ARCH_REVIEW_TIMEOUT_MIN ?? 120)
  return {
    host: env.CLEAN_ARCH_REVIEW_HOST || "127.0.0.1",
    port: Number(env.CLEAN_ARCH_REVIEW_PORT ?? 0) || 0,
    timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60_000,
    openBrowser: !["1", "true", "yes"].includes((env.CLEAN_ARCH_REVIEW_NO_OPEN ?? "").toLowerCase()),
    publicHost: env.CLEAN_ARCH_REVIEW_PUBLIC_HOST || "",
  }
}

/**
 * Serve a Markdown document for review and resolve when the reviewer decides.
 *
 * Every review is archived under `.clean-arch/reviews/<doc>/` as `rN.md` (the reviewed text) and
 * `rN.json` (the feedback), so the next round can show a diff and the previous feedback.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewOutcome> {
  const session = await startReview(options)
  const onAbort = () => session.cancel()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  try {
    return await session.outcome
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
  }
}

export interface ReviewSession {
  url: string
  revision: number
  /** Resolves once the reviewer decides, the timeout passes or `cancel()` is called. */
  outcome: Promise<ReviewOutcome>
  cancel(): void
}

/** Start serving the page and return as soon as it is reachable; `outcome` settles later. */
export async function startReview(options: Omit<ReviewOptions, "signal">): Promise<ReviewSession> {
  const root = path.resolve(options.root)
  const file = path.resolve(root, options.file)
  const relFile = path.relative(root, file)
  if (relFile.startsWith("..") || path.isAbsolute(relFile)) throw new Error(`${options.file} is outside ${root}`)
  const markdown = await readFile(file, "utf8")
  const settings = reviewSettingsFromEnv()
  const host = options.host ?? settings.host
  const token = randomBytes(12).toString("hex")

  const historyDir = path.join(root, ".clean-arch", "reviews", path.basename(file).replace(/\.[^.]+$/, ""))
  await mkdir(historyDir, { recursive: true })
  // Rounds that ended without a decision (timeout, cancel, killed process) are reused.
  const last = (await readHistory(historyDir)).filter((entry) => entry.feedback).at(-1)
  const revision = (last?.revision ?? 0) + 1
  await writeFile(path.join(historyDir, `r${revision}.md`), markdown)

  const diagramNotes: string[] = []
  const page: PageData = {
    title: options.title || firstHeading(markdown) || path.basename(file),
    file: relFile.split(path.sep).join("/"),
    revision,
    token,
    html: renderMarkdown(markdown, path.posix.dirname(relFile.split(path.sep).join("/")), token, diagramNotes),
    diff: last?.markdown !== undefined ? diffLines(last.markdown, markdown) : null,
    previous: last?.feedback
      ? { revision: last.revision, decision: last.feedback.decision, comment: last.feedback.comment, annotations: last.feedback.annotations }
      : null,
  }
  const html = renderPage(page)

  let settle: (outcome: { decision: ReviewOutcome["decision"]; comment: string; annotations: Annotation[] }) => void
  const decided = new Promise<{ decision: ReviewOutcome["decision"]; comment: string; annotations: Annotation[] }>(
    (resolve) => (settle = resolve),
  )

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, "text/plain", String(error)))
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")
    const authorized = url.searchParams.get("t") === token || req.headers["x-review-token"] === token
    if (!authorized) return send(res, 403, "text/plain", "Missing or wrong review token. Open the link printed by the agent.")
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", html)
    if (req.method === "GET" && url.pathname.startsWith("/file/")) return serveImage(res, root, decodeURIComponent(url.pathname.slice(6)))
    if (req.method === "POST" && url.pathname === "/api/decision") {
      const body = parseDecision(await readBody(req))
      if (!body) return send(res, 400, "text/plain", "invalid decision")
      send(res, 200, "application/json", "{\"ok\":true}")
      settle(body)
      return
    }
    send(res, 404, "text/plain", "not found")
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? settings.port, host, () => resolve())
  })
  const { port } = server.address() as AddressInfo
  const shownHost = settings.publicHost || (host === "0.0.0.0" || host === "::" ? os.hostname() : host)
  const url = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}/?t=${token}`
  options.onReady?.(url)
  if (options.openBrowser ?? settings.openBrowser) openInBrowser(url)

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs
  const timer = setTimeout(() => settle({ decision: "timeout", comment: "", annotations: [] }), timeoutMs)

  const outcome = decided.then(async (result): Promise<ReviewOutcome> => {
    clearTimeout(timer)
    server.closeAllConnections?.()
    server.close()
    const recordPath = path.join(historyDir, `r${revision}.json`)
    await writeFile(recordPath, JSON.stringify({ ...result, revision, file: page.file, at: new Date().toISOString() }, null, 2) + "\n")
    return { ...result, revision, record: path.relative(root, recordPath).split(path.sep).join("/"), url, diagramWarnings: diagramNotes }
  })
  return { url, revision, outcome, cancel: () => settle({ decision: "cancelled", comment: "", annotations: [] }) }
}

interface HistoryEntry {
  revision: number
  markdown?: string
  feedback?: { decision: Decision; comment: string; annotations: Annotation[] }
}

async function readHistory(dir: string): Promise<HistoryEntry[]> {
  const entries = new Map<number, HistoryEntry>()
  for (const name of await readdir(dir)) {
    const match = name.match(/^r(\d+)\.(md|json)$/)
    if (!match) continue
    const revision = Number(match[1])
    const entry = entries.get(revision) ?? { revision }
    const text = await readFile(path.join(dir, name), "utf8")
    if (match[2] === "md") entry.markdown = text
    else {
      try {
        const feedback = JSON.parse(text)
        if (DECISIONS.includes(feedback.decision)) entry.feedback = feedback
      } catch {
        // A half-written record only loses the "previous feedback" panel.
      }
    }
    entries.set(revision, entry)
  }
  return [...entries.values()].sort((a, b) => a.revision - b.revision)
}

function parseDecision(raw: string): { decision: Decision; comment: string; annotations: Annotation[] } | null {
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!DECISIONS.includes(body?.decision)) return null
  const kinds = new Set(["comment", "delete", "replace"])
  const annotations: Annotation[] = (Array.isArray(body.annotations) ? body.annotations : [])
    .filter((a: any) => a && kinds.has(a.kind) && typeof a.quote === "string")
    .map((a: any) => ({ kind: a.kind, quote: a.quote, section: String(a.section ?? ""), text: String(a.text ?? "") }))
  return { decision: body.decision, comment: String(body.comment ?? ""), annotations }
}

async function serveImage(res: ServerResponse, root: string, relPath: string) {
  const full = path.resolve(root, relPath)
  const type = IMAGE_TYPES[path.extname(full).toLowerCase()]
  const rel = path.relative(root, full)
  if (!type || rel.startsWith("..") || path.isAbsolute(rel)) return send(res, 404, "text/plain", "not found")
  try {
    const body = await readFile(full)
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-security-policy": "script-src 'none'" })
    res.end(body)
  } catch {
    send(res, 404, "text/plain", "not found")
  }
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  if (res.headersSent) return
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 2_000_000) req.destroy(new Error("body too large"))
      else chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function firstHeading(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? ""
}

function openInBrowser(url: string) {
  const platform = process.platform
  const hasDisplay = platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  if (!hasDisplay) return
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Opening a browser is a convenience; the URL is reported to the agent either way.
  }
}

export function formatOutcome(outcome: ReviewOutcome): string {
  const lines = [`Decision: ${outcome.decision}`, `Revision: ${outcome.revision} (feedback saved to ${outcome.record})`]
  if (outcome.decision === "timeout" || outcome.decision === "cancelled") {
    lines.push("", "No decision was made in the review page. Ask the user in chat to review the file and approve or give feedback.")
    return lines.join("\n")
  }
  if (outcome.comment) lines.push("", "General comment:", outcome.comment)
  if (outcome.diagramWarnings?.length) {
    lines.push("", "Diagram rendering warnings (fix them in this document):", ...outcome.diagramWarnings.map((w) => `- ${w}`))
  }
  if (outcome.annotations.length) {
    lines.push("", `Annotations (${outcome.annotations.length}):`)
    outcome.annotations.forEach((a, i) => {
      const where = a.section ? ` in "${a.section}"` : ""
      const quote = JSON.stringify(a.quote)
      if (a.kind === "replace") lines.push(`${i + 1}. [replace]${where}: ${quote} -> ${JSON.stringify(a.text)}`)
      else if (a.kind === "delete") lines.push(`${i + 1}. [delete]${where}: ${quote}`)
      else lines.push(`${i + 1}. [comment]${where}: ${quote}`, `   ${a.text}`)
    })
  }
  lines.push(
    "",
    outcome.decision === "changes_requested"
      ? "Next: apply every annotation (edit only what the feedback touches), then call clean_arch_review again."
      : outcome.decision === "approved_with_notes"
        ? "Next: apply the notes that do not change scope, then continue with the approved plan."
        : "Next: the document is approved; continue.",
  )
  return lines.join("\n")
}
