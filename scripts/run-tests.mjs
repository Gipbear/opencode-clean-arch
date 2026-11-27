import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function hasBun() {
  const res = spawnSync("bun", ["--version"], { stdio: "ignore" })
  return res.status === 0
}

if (hasBun()) {
  const res = spawnSync("bun", ["test"], { cwd: ROOT, stdio: "inherit" })
  process.exit(res.status ?? 1)
}

mkdirSync(path.join(ROOT, "node_modules", ".cache"), { recursive: true })
// 无 bun 环境：通过 esbuild 把 tests/*.test.ts 编译到 node_modules/.cache 下，使 ESM 包解析命中仓库 node_modules
const tmpDir = mkdtempSync(path.join(ROOT, "node_modules", ".cache", "clean-arch-tests-"))
try {
  const testDir = path.join(ROOT, "tests")
  const testFiles = readdirSync(testDir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(testDir, f))

  const shimPath = path.join(ROOT, "scripts/bun-test-shim.mjs")
  await esbuild.build({
    entryPoints: testFiles,
    outdir: tmpDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
    plugins: [
      {
        name: "bun-test-shim",
        setup(build) {
          build.onResolve({ filter: /^bun:test$/ }, () => ({ path: shimPath }))
        },
      },
    ],
  })

  const builtFiles = readdirSync(tmpDir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join(tmpDir, f))

  const res = spawnSync(process.execPath, ["--test", ...builtFiles], {
    cwd: ROOT,
    stdio: "inherit",
  })
  process.exit(res.status ?? 1)
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
