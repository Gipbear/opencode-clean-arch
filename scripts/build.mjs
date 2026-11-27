import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(ROOT, "dist")

const normalizeLf = (text) => text.replace(/\r\n/g, "\n")

async function collectFilesSorted(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collectFilesSorted(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

async function computeSourceHash() {
  const hash = createHash("sha256")
  const files = await collectFilesSorted(path.join(ROOT, "src"))
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/")
    const content = normalizeLf(await readFile(file, "utf8"))
    hash.update(`${rel}\0${content}\0`)
  }
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))
  hash.update(`package.json\0${JSON.stringify({ version: pkg.version, dependencies: pkg.dependencies })}\0`)
  return hash.digest("hex").slice(0, 16)
}

async function compileMcpAppHtml(srcHash) {
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
  const inlined = template.replace(
    /<script\s+type="module"\s+src="\.\/app\.ts"><\/script>/,
    () => `<script>${js}</script>`,
  )
  return `${inlined.trimEnd()}\n<!-- clean-arch-src-sha256: ${srcHash} -->\n`
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

async function main() {
  const checkOnly = process.argv.includes("--check")
  const srcHash = await computeSourceHash()
  const cliSrc = normalizeLf(await readFile(path.join(ROOT, "src/cli.ts"), "utf8"))
  const cliWithoutShebang = cliSrc.replace(/^#![^\n]*\n/, "")

  const [mcpJs, agyHooksJs, cliJs] = await Promise.all([
    compileNodeEntry(
      `import { runMcpStdio } from "./adapters/mcp.ts";\nrunMcpStdio().catch((e) => { console.error("[clean-arch-mcp] fatal:", e); process.exit(1); });\n`,
    ),
    compileNodeEntry(
      `import { runAgyPreToolUseHook } from "./adapters/agy-hooks.ts";\nvoid runAgyPreToolUseHook();\n`,
    ),
    compileNodeEntry(cliWithoutShebang),
  ])

  const exactNodeTargets = [
    ["mcp.js", mcpJs],
    ["agy-hooks.js", agyHooksJs],
    ["cli.js", cliJs],
  ]

  if (checkOnly) {
    const stale = []
    for (const [name, expected] of exactNodeTargets) {
      const actual = await readFile(path.join(DIST, name), "utf8").then(normalizeLf, () => null)
      if (actual !== expected) stale.push(`dist/${name}`)
    }
    const appHtml = await readFile(path.join(DIST, "review-app.html"), "utf8").then(normalizeLf, () => null)
    const stampMarker = `<!-- clean-arch-src-sha256: ${srcHash} -->`
    if (!appHtml || !appHtml.includes("<script>") || !appHtml.includes(stampMarker)) {
      stale.push("dist/review-app.html")
    }
    if (stale.length > 0) {
      console.error(`Stale or missing prebuilt artifacts: ${stale.join(", ")}. Run "npm run bundle" and commit dist/.`)
      process.exit(1)
    }
    console.log(`Verified dist/ artifacts match src/ (${srcHash}).`)
    return
  }

  const reviewAppHtml = await compileMcpAppHtml(srcHash)
  await mkdir(DIST, { recursive: true })
  await Promise.all([
    writeFile(path.join(DIST, "review-app.html"), reviewAppHtml, "utf8"),
    ...exactNodeTargets.map(([name, content]) => writeFile(path.join(DIST, name), content, "utf8")),
  ])
  console.log(`Built dist/review-app.html, dist/mcp.js, dist/agy-hooks.js, dist/cli.js (${srcHash})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
