import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type WorkflowPhase = "diagnose" | "awaiting_approval" | "executing" | "done"

export interface WorkflowState {
  phase: WorkflowPhase
  doc?: string
  updatedAt: string
}

const VALID_PHASES = new Set<WorkflowPhase>(["diagnose", "awaiting_approval", "executing", "done"])

function stateFilePath(root: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ".clean-arch", "state.json")
  if (!target.startsWith(resolvedRoot + path.sep)) {
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

/** 判断当前阶段是否处于批准前的只读保护期。 */
export function isReadOnlyPhase(state: WorkflowState | null): boolean {
  return state !== null && (state.phase === "diagnose" || state.phase === "awaiting_approval")
}
