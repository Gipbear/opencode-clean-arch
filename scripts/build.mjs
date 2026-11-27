import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(ROOT, "dist")

const normalizeLf = (text) => text.replace(/\r\n/g, "\n")

async function compileMcpAppHtml() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/review/mcp-app/app.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  })
  const js = normalizeLf(bundle.outputFiles[0].text).replace(/<\/script/gi, "<\\/script")
  const template = normalizeLf(await readFile(path.join(ROOT, "src/review/mcp-app/index.html"), "utf8"))
  return template.replace(
    /<script\s+type="module"\s+src="\.\/app\.ts"><\/script>/,
    () => `<script>${js}</script>`,
  )
}

async function compileNodeEntry(contents) {
  const bundle = await esbuild.build({
    stdin: {
      contents: normalizeLf(contents),
      resolveDir: path.join(ROOT, "src"),
      loader: "ts",
    },
    write: false,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
  })
  return normalizeLf(bundle.outputFiles[0].text)
}

async function compileAllTargets() {
  const cliSrc = normalizeLf(await readFile(path.join(ROOT, "src/cli.ts"), "utf8"))
  const cliWithoutShebang = cliSrc.replace(/^#![^\n]*\n/, "")

  const [reviewAppHtml, mcpJs, agyHooksJs, cliJs] = await Promise.all([
    compileMcpAppHtml(),
    compileNodeEntry(
      `import { runMcpStdio } from "./adapters/mcp.ts";\nrunMcpStdio().catch((e) => { console.error("[clean-arch-mcp] fatal:", e); process.exit(1); });\n`,
    ),
    compileNodeEntry(
      `import { runAgyPreToolUseHook } from "./adapters/agy-hooks.ts";\nvoid runAgyPreToolUseHook();\n`,
    ),
    compileNodeEntry(cliWithoutShebang),
  ])

  return [
    ["review-app.html", reviewAppHtml],
    ["mcp.js", mcpJs],
    ["agy-hooks.js", agyHooksJs],
    ["cli.js", cliJs],
  ]
}

async function main() {
  const checkOnly = process.argv.includes("--check")
  const targets = await compileAllTargets()

  if (checkOnly) {
    const stale = []
    for (const [name, expected] of targets) {
      const targetPath = path.join(DIST, name)
      const actual = await readFile(targetPath, "utf8").then(normalizeLf, () => null)
      if (actual !== expected) stale.push(`dist/${name}`)
    }
    if (stale.length > 0) {
      console.error(`Stale or missing prebuilt artifacts: ${stale.join(", ")}. Run "npm run bundle" and commit dist/.`)
      process.exit(1)
    }
    console.log("Verified dist/ artifacts are up to date with src/.")
    return
  }

  await mkdir(DIST, { recursive: true })
  await Promise.all(targets.map(([name, content]) => writeFile(path.join(DIST, name), content, "utf8")))
  console.log("Built dist/review-app.html, dist/mcp.js, dist/agy-hooks.js, dist/cli.js")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
