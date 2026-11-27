import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type WorkflowPhase = "diagnose" | "awaiting_approval" | "executing" | "done"

export interface WorkflowState {
  phase: WorkflowPhase
  doc?: string
  updatedAt: string
}

const VALID_PHASES = new Set<WorkflowPhase>(["diagnose", "awaiting_approval", "executing", "done"])
const DEFAULT_TTL_MINUTES = 240

/** 跨平台安全判断 targetPath 是否位于 rootDir 内部（兼容 Windows 盘符大小写差异与跨盘符路径）。 */
export function isPathInside(rootDir: string, targetPath: string, allowSame = false): boolean {
  const base = path.resolve(rootDir)
  const full = path.resolve(base, targetPath)
  const normBase = process.platform === "win32" ? base.toLowerCase() : base
  const normFull = process.platform === "win32" ? full.toLowerCase() : full
  if (normBase === normFull) return allowSame
  const rel = path.relative(normBase, normFull)
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function stateFilePath(root: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ".clean-arch", "state.json")
  if (!isPathInside(resolvedRoot, target)) {
    throw new Error("Invalid state file path outside workspace root")
  }
  return target
}

/** 读取工作区 `.clean-arch/state.json`；文件不存在或无效时返回 null。 */
export async function readWorkflowState(root: string): Promise<WorkflowState | null> {
  try {
    const raw = await readFile(stateFilePath(root), "utf8")
    const parsed = JSON.parse(raw) as Partial<WorkflowState>
    if (!parsed || !parsed.phase || !VALID_PHASES.has(parsed.phase)) return null
    return {
      phase: parsed.phase,
      doc: typeof parsed.doc === "string" ? parsed.doc : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    }
  } catch {
    return null
  }
}

/** 写入工作区重构阶段状态，供 Antigravity PreToolUse 门禁读取。 */
export async function writeWorkflowState(root: string, phase: WorkflowPhase, doc?: string): Promise<WorkflowState> {
  const file = stateFilePath(root)
  await mkdir(path.dirname(file), { recursive: true })
  const state: WorkflowState = {
    phase,
    ...(doc ? { doc } : {}),
    updatedAt: new Date().toISOString(),
  }
  await writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8")
  return state
}

/** 判断当前阶段是否处于有效的批准前只读保护期（超时陈旧状态自动失效，避免永久锁死工作区）。 */
export function isReadOnlyPhase(state: WorkflowState | null, nowMs: number = Date.now()): boolean {
  if (!state || (state.phase !== "diagnose" && state.phase !== "awaiting_approval")) {
    return false
  }
  const ttlMinutes = Number(process.env.CLEAN_ARCH_STATE_TTL_MIN ?? DEFAULT_TTL_MINUTES)
  const effectiveTtlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60_000
  if (state.updatedAt) {
    const updatedMs = Date.parse(state.updatedAt)
    if (Number.isFinite(updatedMs) && nowMs - updatedMs > effectiveTtlMs) {
      return false
    }
  }
  return true
}
