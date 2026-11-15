#!/usr/bin/env bun
import path from "node:path"
import { renderDiagrams } from "./render.ts"
import { formatOutcome, runReview } from "./review/server.ts"

const USAGE = `usage:
  bun src/cli.ts render [path] [--force]   render *.mmd to *.svg (default docs/architecture/diagrams)
  bun src/cli.ts review <file.md> [--title T]   open the review page and print the decision`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const force = rest.includes("--force")
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--title")
  if (command === "render") {
    const result = await renderDiagrams(path.resolve(positional[0] ?? "docs/architecture/diagrams"), force)
    for (const file of result.rendered) console.log(`+ ${path.relative(process.cwd(), file)}`)
    for (const { file, error } of result.failed) console.error(`! ${path.relative(process.cwd(), file)}: ${error}`)
    for (const { file, message } of result.warnings) console.error(`? ${path.relative(process.cwd(), file)}: ${message}`)
    console.log(`rendered ${result.rendered.length}, up to date ${result.skipped.length}, failed ${result.failed.length}`)
    return result.failed.length ? 1 : 0
  }
  if (command === "review" && positional[0]) {
    const titleIndex = rest.indexOf("--title")
    const outcome = await runReview({
      root: process.cwd(),
      file: positional[0],
      title: titleIndex >= 0 ? rest[titleIndex + 1] : undefined,
      onReady: (url) => console.error(`review page: ${url}`),
    })
    console.log(formatOutcome(outcome))
    return outcome.decision === "approved" || outcome.decision === "approved_with_notes" ? 0 : 1
  }
  console.error(USAGE)
  return 2
}

process.exit(await main(process.argv.slice(2)))
