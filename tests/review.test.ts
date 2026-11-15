import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { diffLines } from "../src/review/diff.ts"
import { renderMarkdown } from "../src/review/markdown.ts"
import { formatOutcome, runReview } from "../src/review/server.ts"

const PLAN = `# Plan: remove billing copy

## Steps

### S1 Delete billing_v2

- Delete: \`shop/services/billing_v2.py\`

\`\`\`mermaid
flowchart LR
  a[shop.services] --> b[shop.core]
\`\`\`

![deps](diagrams/deps.svg)
`

function project(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "clean-arch-review-"))
  mkdirSync(path.join(root, ".clean-arch", "diagrams"), { recursive: true })
  writeFileSync(path.join(root, ".clean-arch", "plan.md"), PLAN)
  writeFileSync(path.join(root, ".clean-arch", "diagrams", "deps.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(path.join(root, "secret.txt"), "do not serve")
  return root
}

function startReview(root: string, extra: Partial<Parameters<typeof runReview>[0]> = {}) {
  let resolveUrl: (url: string) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const outcome = runReview({ root, file: ".clean-arch/plan.md", openBrowser: false, port: 0, onReady: (u) => resolveUrl(u), ...extra })
  return { url, outcome }
}

describe("markdown rendering", () => {
  test("mermaid becomes inline svg, raw html is escaped, images go through /file/", () => {
    const html = renderMarkdown(PLAN + "\n<script>alert(1)</script>\n<sub>ok</sub>\n", ".clean-arch", "tok")
    expect(html).toContain("<figure class=\"diagram\"><svg")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&#60;script&#62;")
    expect(html).toContain("<sub>")
    expect(html).toContain('src="/file/.clean-arch/diagrams/deps.svg?t=tok"')
  })

  test("collects renderer warnings for the agent", () => {
    const warnings: string[] = []
    renderMarkdown("```mermaid\nflowchart TD\n  a <--> b\n```", ".", "t", warnings)
    expect(warnings).toEqual([expect.stringContaining("two-way arrows")])
  })

  test("broken mermaid shows an error and the source", () => {
    const html = renderMarkdown("```mermaid\nnot a diagram\n```", ".", "t")
    expect(html).toContain("Mermaid 渲染失败")
    expect(html).toContain("not a diagram")
  })
})

describe("diff", () => {
  test("marks added and removed lines", () => {
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ])
  })
})

describe("review server", () => {
  test("serves the page with a token, records the decision and archives the revision", async () => {
    const root = project()
    const { url, outcome } = startReview(root)
    const pageUrl = await url
    const base = new URL(pageUrl)
    const token = base.searchParams.get("t")!

    expect((await fetch(`${base.origin}/`)).status).toBe(403)
    const page = await (await fetch(pageUrl)).text()
    expect(page).toContain("Plan: remove billing copy")
    expect(page).toContain("第 1 版")
    expect(page).toContain("<svg")

    const image = await fetch(`${base.origin}/file/.clean-arch/diagrams/deps.svg?t=${token}`)
    expect(image.headers.get("content-type")).toBe("image/svg+xml")
    expect((await fetch(`${base.origin}/file/secret.txt?t=${token}`)).status).toBe(404)
    expect((await fetch(`${base.origin}/file/..%2F..%2Fetc%2Fpasswd.svg?t=${token}`)).status).toBe(404)

    const bad = await fetch(`${base.origin}/api/decision`, {
      method: "POST",
      headers: { "x-review-token": token },
      body: JSON.stringify({ decision: "maybe" }),
    })
    expect(bad.status).toBe(400)

    const ok = await fetch(`${base.origin}/api/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": token },
      body: JSON.stringify({
        decision: "changes_requested",
        comment: "先删副本再拆类",
        annotations: [
          { kind: "replace", quote: "Delete billing_v2", section: "Plan > Steps", text: "Merge billing_v2 into billing" },
          { kind: "delete", quote: "![deps]", section: "", text: "" },
          { kind: "bogus", quote: "x" },
        ],
      }),
    })
    expect(ok.status).toBe(200)

    const result = await outcome
    expect(result.decision).toBe("changes_requested")
    expect(result.annotations).toHaveLength(2)
    expect(result.record).toBe(".clean-arch/reviews/plan/r1.json")
    expect(JSON.parse(readFileSync(path.join(root, result.record), "utf8")).comment).toBe("先删副本再拆类")
    expect(readFileSync(path.join(root, ".clean-arch/reviews/plan/r1.md"), "utf8")).toBe(PLAN)

    const text = formatOutcome(result)
    expect(text).toContain("Decision: changes_requested")
    expect(text).toContain('[replace] in "Plan > Steps": "Delete billing_v2" -> "Merge billing_v2 into billing"')
    expect(text).toContain("call clean_arch_review again")
  })

  test("the second round shows a diff and the previous feedback", async () => {
    const root = project()
    const first = startReview(root)
    const firstUrl = new URL(await first.url)
    await fetch(`${firstUrl.origin}/api/decision`, {
      method: "POST",
      headers: { "x-review-token": firstUrl.searchParams.get("t")! },
      body: JSON.stringify({ decision: "changes_requested", comment: "rename step", annotations: [] }),
    })
    await first.outcome

    writeFileSync(path.join(root, ".clean-arch", "plan.md"), PLAN.replace("Delete billing_v2", "Merge billing_v2 into billing"))
    const second = startReview(root)
    const page = await (await fetch(await second.url)).text()
    expect(page).toContain("第 2 版")
    const data = JSON.parse(page.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1])
    expect(data.previous.comment).toBe("rename step")
    expect(data.diff.some((l: any) => l.kind === "add" && l.text.includes("Merge billing_v2"))).toBe(true)
    const secondUrl = new URL(await second.url)
    await fetch(`${secondUrl.origin}/api/decision`, {
      method: "POST",
      headers: { "x-review-token": secondUrl.searchParams.get("t")! },
      body: JSON.stringify({ decision: "approved", comment: "", annotations: [] }),
    })
    expect((await second.outcome).decision).toBe("approved")
  })

  test("a round that ended without a decision is reused", async () => {
    const root = project()
    const decided = startReview(root)
    const url = new URL(await decided.url)
    await fetch(`${url.origin}/api/decision`, {
      method: "POST",
      headers: { "x-review-token": url.searchParams.get("t")! },
      body: JSON.stringify({ decision: "changes_requested", comment: "first", annotations: [] }),
    })
    await decided.outcome
    expect((await startReview(root, { timeoutMs: 50 }).outcome).revision).toBe(2)
    const again = startReview(root)
    const data = JSON.parse((await (await fetch(await again.url)).text()).match(/id="data">(.*?)<\/script>/s)![1])
    expect(data.revision).toBe(2)
    expect(data.previous.comment).toBe("first")
    const againUrl = new URL(await again.url)
    await fetch(`${againUrl.origin}/api/decision`, {
      method: "POST",
      headers: { "x-review-token": againUrl.searchParams.get("t")! },
      body: JSON.stringify({ decision: "approved", comment: "", annotations: [] }),
    })
    expect((await again.outcome).revision).toBe(2)
  })

  test("times out and cancels", async () => {
    const timedOut = await startReview(project(), { timeoutMs: 50 }).outcome
    expect(timedOut.decision).toBe("timeout")
    expect(formatOutcome(timedOut)).toContain("Ask the user in chat")

    const controller = new AbortController()
    const run = startReview(project(), { signal: controller.signal })
    await run.url
    controller.abort()
    expect((await run.outcome).decision).toBe("cancelled")
  })

  test("refuses files outside the project", async () => {
    await expect(runReview({ root: project(), file: "../../etc/hosts", openBrowser: false })).rejects.toThrow("outside")
  })
})
