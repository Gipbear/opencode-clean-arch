import { spawn } from "node:child_process"
import path from "node:path"
import { PACKAGE_ROOT } from "./paths.ts"

export const SCRIPTS_DIR = path.join(PACKAGE_ROOT, "skills", "clean-arch", "scripts")

export interface ScriptResult {
  code: number
  stdout: string
  stderr: string
}

function pythonCommand(): string {
  return process.env.CLEAN_ARCH_PYTHON || (process.platform === "win32" ? "python" : "python3")
}

/** Run one of the bundled analysis scripts against `root`. The scripts parse code, never import it. */
export function runScript(script: string, root: string, args: string[], signal?: AbortSignal): Promise<ScriptResult> {
  const python = pythonCommand()
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(SCRIPTS_DIR, script), "--root", root, ...args], {
      cwd: root,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      signal,
      timeout: 10 * 60_000,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Python not found ("${python}"). Install Python 3.10+ or set CLEAN_ARCH_PYTHON to its path.`))
      } else reject(error)
    })
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}
