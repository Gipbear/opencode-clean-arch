import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(ROOT, "dist")

async function buildMcpAppHtml() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/review/mcp-app/app.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  })
  const js = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")
  const template = await readFile(path.join(ROOT, "src/review/mcp-app/index.html"), "utf8")
  const html = template.replace(
    /<script\s+type="module"\s+src="\.\/app\.ts"><\/script>/,
    () => `<script>${js}</script>`,
  )
  await writeFile(path.join(DIST, "review-app.html"), html, "utf8")
}

async function buildNodeEntry(contents, outfile) {
  await esbuild.build({
    stdin: {
      contents,
      resolveDir: path.join(ROOT, "src"),
      loader: "ts",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
  })
}

async function buildNodeTargets() {
  await buildNodeEntry(
    `import { runMcpStdio } from "./adapters/mcp.ts";\nrunMcpStdio().catch((e) => { console.error("[clean-arch-mcp] fatal:", e); process.exit(1); });\n`,
    path.join(DIST, "mcp.js"),
  )
  await buildNodeEntry(
    `import { runAgyPreToolUseHook } from "./adapters/agy-hooks.ts";\nvoid runAgyPreToolUseHook();\n`,
    path.join(DIST, "agy-hooks.js"),
  )

  // cli.ts 自身以 #!/usr/bin/env bun 开头，构建为 Node 可执行文件时替换为 node shebang
  const cliSrc = await readFile(path.join(ROOT, "src/cli.ts"), "utf8")
  const cliWithoutShebang = cliSrc.replace(/^#![^\n]*\n/, "")
  await buildNodeEntry(cliWithoutShebang, path.join(DIST, "cli.js"))
}

async function main() {
  await mkdir(DIST, { recursive: true })
  await Promise.all([buildMcpAppHtml(), buildNodeTargets()])
  console.log("Built dist/review-app.html, dist/mcp.js, dist/agy-hooks.js, dist/cli.js")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
