import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { diffLines } from "./diff.ts"
import { renderMarkdown } from "./markdown.ts"
import type { PageData } from "./page.ts"
import { isPathInside, readWorkflowState, writeWorkflowState } from "./state.ts"
import type { Annotation, Decision, ReviewOutcome } from "./types.ts"

const DECISIONS: Decision[] = ["approved", "approved_with_notes", "changes_requested"]
const ANNOTATION_KINDS = new Set<Annotation["kind"]>(["comment", "delete", "replace"])

export const IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export interface ReviewDraft {
  comment: string
  annotations: Array<Annotation & { id?: string; anchor?: number }>
}

export interface PreparedReview {
  root: string
  relFile: string
  historyDir: string
  page: PageData
  diagramWarnings: string[]
  draft: ReviewDraft | null
}

/** 校验并解析项目内的目标文件路径，拒绝越界访问（兼容 Windows 盘符大小写差异）。 */
export function resolveProjectFile(rootDir: string, targetFile: string): { root: string; full: string; relFile: string } {
  const root = path.resolve(rootDir)
  const full = path.resolve(root, targetFile)
  if (!isPathInside(root, full)) {
    throw new Error(`${targetFile} is outside ${root}`)
  }
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root
  const normFull = process.platform === "win32" ? full.toLowerCase() : full
  const relNorm = path.relative(normRoot, normFull)
  const relActual = full.slice(full.length - relNorm.length)
  return { root, full, relFile: relActual.split(path.sep).join("/") }
}

/** 计算评审历史目录路径：`.clean-arch/<name>.md` 保持 `<name>`，其余按相对路径生成无碰撞目录名。 */
export function historyDirFor(root: string, fileFullPath: string): string {
  const { relFile } = resolveProjectFile(root, fileFullPath)
  const withoutExt = relFile.replace(/\.[^./]+$/, "")
  const cleanArchMatch = withoutExt.match(/^\.clean-arch\/([^/]+)$/)
  const slug = cleanArchMatch
    ? cleanArchMatch[1]
    : withoutExt.replace(/^\.clean-arch\//, "").replace(/\//g, "__").replace(/[^A-Za-z0-9_.\-\u4e00-\u9fa5]/g, "_")
  return path.join(path.resolve(root), ".clean-arch", "reviews", slug || "doc")
}

/** 打开评审会话时，将重构跟踪中的文档切换至 `awaiting_approval` 只读保护期。 */
export async function enterReviewState(root: string, relFile: string): Promise<void> {
  const existingState = await readWorkflowState(root)
  if (existingState || relFile === ".clean-arch/plan.md" || relFile === ".clean-arch/perf.md") {
    await writeWorkflowState(root, "awaiting_approval", relFile)
  }
}

export function firstHeading(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? ""
}

export interface HistoryEntry {
  revision: number
  markdown?: string
  feedback?: { decision: Decision; comment: string; annotations: Annotation[] }
}

export async function readHistory(dir: string): Promise<HistoryEntry[]> {
  const entries = new Map<number, HistoryEntry>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  for (const name of names) {
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
        // 半写入或损坏的历史文件仅丢弃“上一版意见”面板，不阻断评审
      }
    }
    entries.set(revision, entry)
  }
  return [...entries.values()].sort((a, b) => a.revision - b.revision)
}

export function normalizeAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a: any) => a && ANNOTATION_KINDS.has(a.kind) && typeof a.quote === "string")
    .map((a: any) => ({
      kind: a.kind,
      quote: a.quote,
      section: String(a.section ?? ""),
      text: String(a.text ?? ""),
    }))
}

export function parseDecision(raw: string): { decision: Decision; comment: string; annotations: Annotation[] } | null {
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  if (!DECISIONS.includes(body?.decision)) return null
  return {
    decision: body.decision,
    comment: String(body.comment ?? ""),
    annotations: normalizeAnnotations(body.annotations),
  }
}

/** 准备评审页面所需的数据、版本号、Diff 与历史意见，并写入本轮文本快照。 */
export async function prepareReviewDocument(options: {
  root: string
  file: string
  title?: string
  token?: string
  imageMode?: "http" | "inline"
}): Promise<PreparedReview> {
  const { root, full, relFile } = resolveProjectFile(options.root, options.file)
  const markdown = await readFile(full, "utf8")
  const historyDir = historyDirFor(root, full)
  await mkdir(historyDir, { recursive: true })

  // 未给出评审结论的轮次（超时、取消、进程退出）可复用到同一版本号
  const last = (await readHistory(historyDir)).filter((entry) => entry.feedback).at(-1)
  const revision = (last?.revision ?? 0) + 1
  await writeFile(path.join(historyDir, `r${revision}.md`), markdown, "utf8")

  const token = options.token ?? ""
  const diagramWarnings: string[] = []
  const docDir = path.posix.dirname(relFile)
  const html = renderMarkdown(markdown, docDir, token, diagramWarnings, {
    imageMode: options.imageMode ?? "http",
    rootDir: root,
  })
  const draft = await loadReviewDraft(historyDir, revision)

  const page: PageData = {
    title: options.title || firstHeading(markdown) || path.basename(full),
    file: relFile,
    revision,
    token,
    html,
    diff: last?.markdown !== undefined ? diffLines(last.markdown, markdown) : null,
    previous: last?.feedback
      ? {
          revision: last.revision,
          decision: last.feedback.decision,
          comment: last.feedback.comment,
          annotations: last.feedback.annotations,
        }
      : null,
  }
  return { root, relFile, historyDir, page, diagramWarnings, draft }
}

/** 读取指定轮次的实时草稿。 */
export async function loadReviewDraft(historyDir: string, revision: number): Promise<ReviewDraft | null> {
  try {
    const raw = await readFile(path.join(historyDir, `draft-r${revision}.json`), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations
          .filter((a: any) => a && ANNOTATION_KINDS.has(a.kind) && typeof a.quote === "string")
          .map((a: any) => ({
            id: typeof a.id === "string" ? a.id : undefined,
            anchor: typeof a.anchor === "number" ? a.anchor : undefined,
            kind: a.kind,
            quote: a.quote,
            section: String(a.section ?? ""),
            text: String(a.text ?? ""),
          }))
      : []
    return { comment: String(parsed.comment ?? ""), annotations }
  } catch {
    return null
  }
}

/** 保存指定轮次的实时草稿（适用于无 localStorage 持久化的隔离 iframe）。 */
export async function saveReviewDraft(
  rootDir: string,
  file: string,
  revision: number,
  draft: ReviewDraft,
): Promise<void> {
  const { root, full } = resolveProjectFile(rootDir, file)
  const historyDir = historyDirFor(root, full)
  await mkdir(historyDir, { recursive: true })
  const clean: ReviewDraft = {
    comment: String(draft.comment ?? ""),
    annotations: Array.isArray(draft.annotations)
      ? draft.annotations
          .filter((a) => a && ANNOTATION_KINDS.has(a.kind) && typeof a.quote === "string")
          .map((a) => ({
            ...(typeof a.id === "string" ? { id: a.id } : {}),
            ...(typeof a.anchor === "number" ? { anchor: a.anchor } : {}),
            kind: a.kind,
            quote: a.quote,
            section: String(a.section ?? ""),
            text: String(a.text ?? ""),
          }))
      : [],
  }
  await writeFile(path.join(historyDir, `draft-r${revision}.json`), JSON.stringify(clean, null, 2) + "\n", "utf8")
}

/** 记录评审结论、清理草稿并同步工作流状态机。 */
export async function commitReviewDecision(options: {
  root: string
  file: string
  revision: number
  decision: ReviewOutcome["decision"]
  comment: string
  annotations: Annotation[]
  diagramWarnings?: string[]
  url: string
}): Promise<ReviewOutcome> {
  const { root, full, relFile } = resolveProjectFile(options.root, options.file)
  if (options.decision === "timeout" || options.decision === "cancelled") {
    return {
      decision: options.decision,
      comment: "",
      annotations: [],
      revision: options.revision,
      record: "",
      url: options.url,
      diagramWarnings: options.diagramWarnings,
    }
  }

  const historyDir = historyDirFor(root, full)
  await mkdir(historyDir, { recursive: true })
  const recordPath = path.join(historyDir, `r${options.revision}.json`)
  const payload = {
    decision: options.decision,
    comment: options.comment,
    annotations: options.annotations,
    revision: options.revision,
    file: relFile,
    at: new Date().toISOString(),
  }
  await writeFile(recordPath, JSON.stringify(payload, null, 2) + "\n", "utf8")
  await rm(path.join(historyDir, `draft-r${options.revision}.json`), { force: true })

  // 当工作区处于架构重构状态流中，或评审计划/性能文档时，自动同步阶段状态供 Hook 门禁使用
  const existingState = await readWorkflowState(root)
  const isTrackedPlan = relFile === ".clean-arch/plan.md" || relFile === ".clean-arch/perf.md"
  if (existingState || isTrackedPlan) {
    if (options.decision === "approved" || options.decision === "approved_with_notes") {
      await writeWorkflowState(root, "executing", relFile)
    } else if (options.decision === "changes_requested") {
      await writeWorkflowState(root, "awaiting_approval", relFile)
    }
  }

  const normRoot = process.platform === "win32" ? root.toLowerCase() : root
  const normRec = process.platform === "win32" ? recordPath.toLowerCase() : recordPath
  const relLen = path.relative(normRoot, normRec).length
  const recordRel = recordPath.slice(recordPath.length - relLen).split(path.sep).join("/")

  return {
    decision: options.decision,
    comment: options.comment,
    annotations: options.annotations,
    revision: options.revision,
    record: recordRel,
    url: options.url,
    diagramWarnings: options.diagramWarnings,
  }
}

/** 安全读取工作区内的白名单图片。 */
export async function readSafeProjectImage(
  rootDir: string,
  relPath: string,
): Promise<{ type: string; body: Buffer } | null> {
  const root = path.resolve(rootDir)
  const full = path.resolve(root, relPath)
  const type = IMAGE_TYPES[path.extname(full).toLowerCase()]
  if (!type || !isPathInside(root, full)) return null
  try {
    const body = await readFile(full)
    return { type, body }
  } catch {
    return null
  }
}

export function formatOutcome(outcome: ReviewOutcome): string {
  if (outcome.decision === "timeout" || outcome.decision === "cancelled") {
    return [
      `Decision: ${outcome.decision}`,
      `Revision: ${outcome.revision} (undecided; any saved draft was preserved)`,
      "",
      "No decision was made in the review page. Ask the user in chat to review the file and approve or give feedback.",
    ].join("\n")
  }
  const lines = [`Decision: ${outcome.decision}`, `Revision: ${outcome.revision} (feedback saved to ${outcome.record})`]
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
