import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import { renderPage } from "./page.ts"
import {
  commitReviewDecision,
  formatOutcome,
  parseDecision,
  prepareReviewDocument,
  readSafeProjectImage,
} from "./store.ts"
import type { Annotation, ReviewOutcome } from "./types.ts"

export { formatOutcome }

export interface ReviewOptions {
  /** 项目根目录；评审文档与服务内静态图片必须位于此目录内。 */
  root: string
  /** 待评审的 Markdown 文件路径（绝对路径或相对 root 的路径）。 */
  file: string
  title?: string
  host?: string
  port?: number
  timeoutMs?: number
  openBrowser?: boolean
  signal?: AbortSignal
  onReady?: (url: string) => void
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

/** 启动 Markdown 评审页并等待用户提交结论或超时/取消。 */
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
  /** 当评审提交、超时或调用 cancel() 时结束。 */
  outcome: Promise<ReviewOutcome>
  cancel(): void
}

/** 启动本地 HTTP 评审服务并立即可访问；评审结论通过 `outcome` 异步返回。 */
export async function startReview(options: Omit<ReviewOptions, "signal">): Promise<ReviewSession> {
  const settings = reviewSettingsFromEnv()
  const host = options.host ?? settings.host
  const token = randomBytes(12).toString("hex")
  const prepared = await prepareReviewDocument({
    root: options.root,
    file: options.file,
    title: options.title,
    token,
    imageMode: "http",
  })
  const html = renderPage(prepared.page)

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
    if (req.method === "GET" && url.pathname.startsWith("/file/")) {
      const img = await readSafeProjectImage(prepared.root, decodeURIComponent(url.pathname.slice(6)))
      if (!img) return send(res, 404, "text/plain", "not found")
      res.writeHead(200, { "content-type": img.type, "cache-control": "no-store", "content-security-policy": "script-src 'none'" })
      res.end(img.body)
      return
    }
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
    return commitReviewDecision({
      root: prepared.root,
      file: prepared.relFile,
      revision: prepared.page.revision,
      decision: result.decision,
      comment: result.comment,
      annotations: result.annotations,
      diagramWarnings: prepared.diagramWarnings,
      url,
    })
  })
  return { url, revision: prepared.page.revision, outcome, cancel: () => settle({ decision: "cancelled", comment: "", annotations: [] }) }
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  if (res.headersSent) return
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" })
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
    // 浏览器打开失败不影响 Agent 输出 URL
  }
}
