import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.ts"
import { diagramWarnings, flattenSvg, mermaidToSvg, renderDiagrams } from "../src/render.ts"
import { loadSkills, parseSkill } from "../src/skills.ts"
import { SKILLS_DIR } from "../src/paths.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "sample_repo")

function fixtureCopy(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clean-arch-"))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

describe("skills", () => {
  test("every skill has a matching name and a usable description", async () => {
    const skills = await loadSkills()
    expect(skills.map((s) => s.id)).toEqual([
      "arch-diagnose",
      "arch-map",
      "arch-plan",
      "clean-arch",
      "clean-finish",
      "comment-hygiene",
      "perf-tune",
      "restructure-modules",
      "simplify-code",
    ])
    for (const skill of skills) {
      expect(skill.name).toBe(skill.id)
      expect(skill.description.length).toBeGreaterThan(80)
      expect(skill.description.length).toBeLessThanOrEqual(1024)
      expect(skill.content.startsWith("---")).toBe(false)
    }
  })

  test("relative references inside skills point at existing files", async () => {
    for (const skill of await loadSkills()) {
      const dir = path.dirname(skill.path)
      const refs = skill.content.match(/`((?:\.\.\/[\w-]+\/)?(?:scripts|references)\/[\w./-]+)`/g) ?? []
      for (const ref of refs) {
        const rel = ref.slice(1, -1)
        if (rel.endsWith("/")) continue
        expect(existsSync(path.join(dir, rel))).toBe(true)
      }
    }
  })

  test("parseSkill strips quotes and frontmatter", () => {
    const { fields, body } = parseSkill('---\nname: "x"\ndescription: does things\n---\n# Body\n')
    expect(fields).toEqual({ name: "x", description: "does things" })
    expect(body).toBe("# Body\n")
  })
})

describe("opencode 2.x setup()", () => {
  async function setup(directory: string) {
    const added: Record<string, any[]> = { skill: [], command: [], tool: [] }
    const prompts: any[] = []
    const editor = (kind: string) => ({ get: () => undefined, add: (item: any) => added[kind].push(item) })
    const ctx = {
      location: { directory },
      skill: { transform: async (fn: any) => fn(editor("skill")) },
      command: { transform: async (fn: any) => fn(editor("command")) },
      tool: { transform: async (fn: any) => fn(editor("tool")) },
      session: { prompt: async (input: any) => prompts.push(input) },
    }
    await plugin.setup(ctx)
    return { added, prompts }
  }

  test("registers skills, commands and tools", async () => {
    const { added } = await setup(fixtureCopy())
    expect(added.skill).toHaveLength(9)
    expect(added.skill[0].path.startsWith(SKILLS_DIR)).toBe(true)
    expect(added.command.map((c) => c.name)).toEqual(["clean-arch", "arch-diagnose", "arch-map", "clean-finish", "arch-review"])
    expect(added.tool.map((t) => t.name)).toEqual(["clean_arch_facts", "clean_arch_leftovers", "clean_arch_render", "clean_arch_review"])
    const review = added.tool.find((t) => t.name === "clean_arch_review")
    expect(review.input.required).toEqual(["path"])
    expect(review.input.additionalProperties).toBe(false)
  })

  test("commands forward the expanded prompt to the session", async () => {
    const { added, prompts } = await setup(fixtureCopy())
    const command = added.command.find((c) => c.name === "clean-arch")
    await command.execute({ sessionID: "s1", prompt: { text: "shop/services" }, delivery: "steer" })
    expect(prompts[0].sessionID).toBe("s1")
    expect(prompts[0].delivery).toBe("steer")
    expect(prompts[0].text).toContain("Scope: shop/services")
  })

  test("tools run the analysis scripts in the plugin location", async () => {
    const dir = fixtureCopy()
    const { added } = await setup(dir)
    const progress: any[] = []
    const facts = added.tool.find((t) => t.name === "clean_arch_facts")
    const result = await facts.execute({}, { progress: async (p: any) => progress.push(p), signal: new AbortController().signal })
    expect(result.content).toContain("shop.core")
    expect(progress[0].status).toContain("clean_arch_facts")
    const json = await facts.execute({ command: "json" }, {})
    expect(json.content).toContain(".clean-arch/cache/facts.json")
    expect(JSON.parse(readFileSync(path.join(dir, ".clean-arch/cache/facts.json"), "utf8")).package_cycles).toHaveLength(1)
  })
})

describe("opencode 1.x server()", () => {
  test("config hook adds the skills path and commands without overriding user commands", async () => {
    const hooks = await plugin.server({ directory: "/tmp" })
    const config: any = { skills: { paths: ["/existing"] }, command: { "arch-map": { template: "mine" } } }
    await hooks.config(config)
    await hooks.config(config)
    expect(config.skills.paths).toEqual(["/existing", SKILLS_DIR])
    expect(config.command["arch-map"].template).toBe("mine")
    expect(config.command["clean-arch"].template).toContain("$ARGUMENTS")
  })

  test("tools validate with zod and execute against the session directory", async () => {
    const { tool } = await import("@opencode-ai/plugin")
    const hooks = await plugin.server({ directory: "/nowhere" })
    expect(Object.keys(hooks.tool)).toHaveLength(4)
    const leftovers = hooks.tool.clean_arch_leftovers
    const schema = tool.schema.object(leftovers.args)
    expect(schema.safeParse({ since: "HEAD", skip: ["todo"] }).success).toBe(true)
    expect(schema.safeParse({ limit: "many" }).success).toBe(false)
    const titles: string[] = []
    const output = await leftovers.execute({}, {
      directory: fixtureCopy(),
      abort: new AbortController().signal,
      metadata: ({ title }: any) => titles.push(title),
    } as any)
    expect(output).toContain("compat-shim")
    expect(titles).toEqual(["clean_arch_leftovers"])
    expect(tool.schema.object(hooks.tool.clean_arch_review.args).safeParse({}).success).toBe(false)
  })
})

describe("diagram rendering", () => {
  test("produces self-contained SVG with literal colours", () => {
    const svg = mermaidToSvg("flowchart LR\n  a[入口] --> b[(知识库)]")
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).not.toContain("var(")
    expect(svg).not.toContain("color-mix")
    expect(svg).not.toContain("@import")
    expect(svg).toContain("知识库")
  })

  test("resolves color-mix percentages", () => {
    const svg = flattenSvg('<svg style="--bg:#FFFFFF;--fg:#000000;background:var(--bg)"><style>svg { --_line: color-mix(in srgb, var(--fg) 50%, var(--bg)); }</style><path stroke="var(--_line)"/></svg>')
    expect(svg).toContain('stroke="#808080"')
    expect(svg).toContain('style="background:#FFFFFF"')
  })

  test("class diagram generics render as angle brackets", () => {
    const svg = mermaidToSvg("classDiagram\n  class Repo {\n    +all() list~Order~\n  }")
    expect(svg).toContain("list&lt;Order&gt;")
  })

  test("warns about syntax the renderer mishandles and about wide diagrams", () => {
    const sequence = "sequenceDiagram\n  autonumber\n  A->>B: hi"
    expect(diagramWarnings(sequence, mermaidToSvg(sequence))).toEqual([expect.stringContaining("autonumber")])
    const chain = "flowchart LR\n  " + Array.from({ length: 14 }, (_, i) => `s${i}[stage number ${i}]`).join(" --> ")
    expect(diagramWarnings(chain, mermaidToSvg(chain)).join()).toContain("px wide")
    const bad = "flowchart TD\n  subgraph 现状\n    a <--> b\n    c -.复制.-> a\n  end"
    expect(diagramWarnings(bad, mermaidToSvg(bad))).toHaveLength(3)
    const tidy = "flowchart TD\n  subgraph now[\"现状\"]\n    a -- 调用 --> b\n    c -.->|复制| a\n  end"
    expect(diagramWarnings(tidy, mermaidToSvg(tidy))).toEqual([])
  })

  test("renderDiagrams writes svg next to mmd and skips up-to-date files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clean-arch-mmd-"))
    mkdirSync(path.join(dir, "d"))
    writeFileSync(path.join(dir, "d", "a.mmd"), "sequenceDiagram\n  A->>B: hi")
    writeFileSync(path.join(dir, "d", "bad.mmd"), "notADiagram ???")
    const first = await renderDiagrams(dir)
    expect(first.rendered.map((f) => path.basename(f))).toEqual(["a.svg"])
    expect(first.failed.map((f) => path.basename(f.file))).toEqual(["bad.mmd"])
    const second = await renderDiagrams(dir)
    expect(second.skipped.map((f) => path.basename(f))).toEqual(["a.svg"])
  })
})
