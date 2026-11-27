import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 向上查找同时包含 package.json 与 skills 目录的包根目录，兼容 src/ 与 dist/ 运行。 */
function findPackageRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "skills"))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(startDir, "..")
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))

export const PACKAGE_ROOT = findPackageRoot(THIS_DIR)
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills")
export const DIST_DIR = path.join(PACKAGE_ROOT, "dist")
