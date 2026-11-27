import path from "node:path"
import { isReadOnlyPhase, readWorkflowState } from "../review/state.ts"

export interface HookPayload {
  hookEventName?: string
  cwd?: string
  workspacePaths?: string[]
  toolCall?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
}

export interface PreToolUseDecision {
  decision: "allow" | "deny" | "ask" | "force_ask"
  reason?: string
}

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
])

function extractTargetPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null
  for (const key of ["Path", "TargetFile", "path", "file_path", "filePath", "target_file"]) {
    const val = args[key]
    if (typeof val === "string" && val.trim()) return val.trim()
  }
  return null
}

function isAllowedWriteTarget(root: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(resolvedRoot, targetPath)
  // 工作区外路径（例如 Antigravity Artifacts 目录）不在此门禁范围内
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    return true
  }
  const cleanArchDir = path.join(resolvedRoot, ".clean-arch")
  const archDocsDir = path.join(resolvedRoot, "docs", "architecture")
  const gitExclude = path.join(resolvedRoot, ".git", "info", "exclude")
  return (
    resolvedTarget === cleanArchDir ||
    resolvedTarget.startsWith(cleanArchDir + path.sep) ||
    resolvedTarget === archDocsDir ||
    resolvedTarget.startsWith(archDocsDir + path.sep) ||
    resolvedTarget === gitExclude
  )
}

/** 评估 Antigravity PreToolUse 请求：当处于诊断或待批阶段时阻止修改业务源码。 */
export async function evaluatePreToolUse(payload: HookPayload): Promise<PreToolUseDecision> {
  const toolName = payload.toolCall?.name ?? ""
  if (!WRITE_TOOLS.has(toolName)) {
    return { decision: "allow" }
  }

  const root = payload.cwd || payload.workspacePaths?.[0]
  if (!root) {
    return { decision: "allow" }
  }

  const state = await readWorkflowState(root)
  if (!isReadOnlyPhase(state)) {
    return { decision: "allow" }
  }

  const targetPath = extractTargetPath(payload.toolCall?.args)
  if (!targetPath || isAllowedWriteTarget(root, targetPath)) {
    return { decision: "allow" }
  }

  const phaseLabel = state?.phase === "diagnose" ? "架构诊断" : "方案待评审"
  return {
    decision: "deny",
    reason: `Clean-Arch 门禁拦截：当前工作区处于【${phaseLabel}】只读阶段（${state?.doc ?? ".clean-arch/plan.md"}），在评审批准前禁止修改业务文件 ${targetPath}。`,
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** 执行 Antigravity PreToolUse Hook（供 dist/agy-hooks.js 入口调用，无模块加载副作用）。 */
export async function runAgyPreToolUseHook(): Promise<void> {
  try {
    const raw = await readStdin()
    let payload: HookPayload = {}
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as HookPayload
      } catch {
        process.stdout.write(JSON.stringify({ decision: "allow" }))
        return
      }
    }
    const result = await evaluatePreToolUse(payload)
    process.stdout.write(JSON.stringify(result))
  } catch {
    // 异常时 fail-open 放行，避免阻塞无关会话
    process.stdout.write(JSON.stringify({ decision: "allow" }))
  }
}
