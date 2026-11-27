import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { evaluatePreToolUse } from "../src/adapters/agy-hooks.ts"
import { createCleanArchMcpServer, REVIEW_APP_URI } from "../src/adapters/mcp.ts"
import { DIST_DIR, PACKAGE_ROOT } from "../src/paths.ts"
import { readWorkflowState, writeWorkflowState } from "../src/review/state.ts"

const FIXTURE = path.join(PACKAGE_ROOT, "tests", "fixtures", "sample_repo")

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clean-arch-agy-"))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

describe("Antigravity plugin manifest & build artifacts", () => {
  test("plugin.json, mcp_config.json, hooks.json and built review-app.html are valid", () => {
    const pluginJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "plugin.json"), "utf8"))
    expect(pluginJson.name).toBe("clean-arch")
    expect(pluginJson.suggestedPrompts).toHaveLength(4)

    const mcpConfig = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "mcp_config.json"), "utf8"))
    expect(mcpConfig.mcpServers["clean-arch"].command).toBe("node")
    expect(mcpConfig.mcpServers["clean-arch"].args).toEqual(["${PLUGIN_ROOT}/dist/mcp.js"])

    const hooksConfig = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "hooks.json"), "utf8"))
    expect(hooksConfig["clean-arch-readonly-guard"].PreToolUse).toHaveLength(1)
    expect(hooksConfig["clean-arch-readonly-guard"].PreToolUse[0].hooks[0].command).toContain("${PLUGIN_ROOT}/dist/agy-hooks.js")

    const appHtmlPath = path.join(DIST_DIR, "review-app.html")
    expect(existsSync(appHtmlPath)).toBe(true)
    const html = readFileSync(appHtmlPath, "utf8")
    expect(html).not.toContain('src="./app.ts"')
    expect(html).toContain("<script>")
    expect(existsSync(path.join(DIST_DIR, "mcp.js"))).toBe(true)
    expect(existsSync(path.join(DIST_DIR, "agy-hooks.js"))).toBe(true)
    expect(existsSync(path.join(DIST_DIR, "cli.js"))).toBe(true)
  })
})

describe("MCP server & Antigravity MCP App integration", () => {
  test("exposes tools, ui:// resource, root-scoped analysis and full side-pane review flow", async () => {
    const server = createCleanArchMcpServer()
    const client = new Client({ name: "test-client", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toContain("clean_arch_facts")
      expect(names).toContain("clean_arch_leftovers")
      expect(names).toContain("clean_arch_render")
      expect(names).toContain("clean_arch_review")
      expect(names).toContain("clean_arch_perf")
      expect(names).toContain("review_app_load")
      expect(names).toContain("review_app_save_draft")
      expect(names).toContain("review_app_submit")

      const reviewTool = tools.find((t) => t.name === "clean_arch_review")!
      expect((reviewTool._meta as any)?.ui?.resourceUri).toBe(REVIEW_APP_URI)
      expect((reviewTool._meta as any)?.["com.google.antigravity/ui"]?.entrypoints?.[0]?.type).toBe("aux_pane")

      const { resources } = await client.listResources()
      expect(resources.some((r) => r.uri === REVIEW_APP_URI && r.mimeType === RESOURCE_MIME_TYPE)).toBe(true)

      const resRead = await client.readResource({ uri: REVIEW_APP_URI })
      expect((resRead.contents[0] as any).text).toContain("架构方案评审")

      const repo = makeTempRepo()
      const factsRes = await client.callTool({ name: "clean_arch_facts", arguments: { root: repo, command: "summary", brief: true } })
      const factsText = (factsRes.content as any[])[0].text
      expect(factsText).toContain("Python files")

      // 未生成 plan.md 时默认空对象入口调用不报错，返回 empty 引导态
      const emptyPanel = await client.callTool({ name: "clean_arch_review", arguments: { root: repo } })
      expect((emptyPanel.structuredContent as any).mode).toBe("empty")

      // 准备带相对路径 SVG 的 plan.md 并打开侧边栏评审
      mkdirSync(path.join(repo, ".clean-arch", "diagrams"), { recursive: true })
      writeFileSync(path.join(repo, ".clean-arch", "diagrams", "dep.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      writeFileSync(path.join(repo, ".clean-arch", "plan.md"), "# Plan (Round 1): Test\n\n![dep](diagrams/dep.svg)\n")

      const opened = await client.callTool({ name: "clean_arch_review", arguments: { root: repo, path: ".clean-arch/plan.md" } })
      expect((opened.structuredContent as any).mode).toBe("review")
      expect((opened.structuredContent as any).revision).toBe(1)
      expect((await readWorkflowState(repo))?.phase).toBe("awaiting_approval")

      // UI 挂载后加载全量渲染内容，验证相对 SVG 被安全内联为 data URI
      const loaded = await client.callTool({
        name: "review_app_load",
        arguments: { root: repo, file: ".clean-arch/plan.md" },
      })
      expect((loaded.structuredContent as any).html).toContain("data:image/svg+xml;base64,")

      // 实时保存草稿并在重新加载时恢复
      await client.callTool({
        name: "review_app_save_draft",
        arguments: {
          root: repo,
          file: ".clean-arch/plan.md",
          revision: 1,
          draft: { comment: "草稿意见", annotations: [{ kind: "comment", quote: "Test", section: "Plan", text: "补充验证" }] },
        },
      })
      const reloaded = await client.callTool({
        name: "review_app_load",
        arguments: { root: repo, file: ".clean-arch/plan.md" },
      })
      expect((reloaded.structuredContent as any).draft.comment).toBe("草稿意见")
      expect((reloaded.structuredContent as any).draft.annotations).toHaveLength(1)
      const uiToken = (reloaded.structuredContent as any).uiToken
      expect(typeof uiToken).toBe("string")

      // 模型若不带有效 uiToken 直接盲调 review_app_submit 自批，必须被拒绝且保持只读锁
      const forged = await client.callTool({
        name: "review_app_submit",
        arguments: {
          root: repo,
          file: ".clean-arch/plan.md",
          revision: 1,
          decision: "approved",
          comment: "",
          annotations: [],
        },
      })
      expect(forged.isError).toBe(true)
      expect((await readWorkflowState(repo))?.phase).toBe("awaiting_approval")

      // 携带 UI 下发的 uiToken 提交批准：保存记录并自动将工作流状态推进到 executing
      const submitted = await client.callTool({
        name: "review_app_submit",
        arguments: {
          root: repo,
          file: ".clean-arch/plan.md",
          revision: 1,
          decision: "approved",
          comment: "",
          annotations: [],
          uiToken,
        },
      })
      expect((submitted.structuredContent as any).decision).toBe("approved")
      expect((submitted.structuredContent as any).formatted).toContain("Decision: approved")
      expect((await readWorkflowState(repo))?.phase).toBe("executing")
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })

  test("auto-falls back to HTTP open mode on non-UI MCP clients like Cursor", async () => {
    process.env.CLEAN_ARCH_REVIEW_NO_OPEN = "1"
    const server = createCleanArchMcpServer()
    const cursorClient = new Client({ name: "cursor-vscode", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), cursorClient.connect(clientTransport)])
    const repo = makeTempRepo()
    mkdirSync(path.join(repo, ".clean-arch"), { recursive: true })
    writeFileSync(path.join(repo, ".clean-arch", "plan.md"), "# Plan\n")
    try {
      const res = await cursorClient.callTool({ name: "clean_arch_review", arguments: { root: repo, path: ".clean-arch/plan.md" } })
      const text = (res.content as any[])[0].text
      expect(text).toContain("Review page is ready: http://")
      const pageUrl = new URL(text.match(/https?:\/\/\S+/)![0])
      const waitPromise = cursorClient.callTool({
        name: "clean_arch_review",
        arguments: { root: repo, path: ".clean-arch/plan.md", action: "wait" },
      })
      await fetch(`${pageUrl.origin}/api/decision`, {
        method: "POST",
        headers: { "x-review-token": pageUrl.searchParams.get("t")! },
        body: JSON.stringify({ decision: "approved", comment: "lgtm", annotations: [] }),
      })
      const waited = await waitPromise
      expect((waited.content as any[])[0].text).toContain("Decision: approved")
      expect((await readWorkflowState(repo))?.phase).toBe("executing")
    } finally {
      await Promise.all([cursorClient.close(), server.close()])
    }
  })
})

describe("Antigravity PreToolUse read-only guard", () => {
  test("blocks source writes only during diagnose/awaiting_approval and allows .clean-arch writes", async () => {
    const repo = makeTempRepo()

    // 没有 state.json 时完全放行，不干扰普通项目
    expect(
      (
        await evaluatePreToolUse({
          cwd: repo,
          toolCall: { name: "write_file", args: { Path: path.join(repo, "shop/core/pricing.py") } },
        })
      ).decision,
    ).toBe("allow")

    await writeWorkflowState(repo, "diagnose", ".clean-arch/diagnosis.md")

    const blocked = await evaluatePreToolUse({
      cwd: repo,
      toolCall: { name: "replace_file_content", args: { TargetFile: path.join(repo, "shop/core/pricing.py") } },
    })
    expect(blocked.decision).toBe("deny")
    expect(blocked.reason).toContain("只读阶段")

    // .clean-arch 与 docs/architecture 以及工作区外目录均放行
    expect(
      (
        await evaluatePreToolUse({
          cwd: repo,
          toolCall: { name: "write_file", args: { Path: path.join(repo, ".clean-arch/plan.md") } },
        })
      ).decision,
    ).toBe("allow")

    expect(
      (
        await evaluatePreToolUse({
          cwd: repo,
          toolCall: { name: "write_file", args: { Path: path.join(os.tmpdir(), "scratch.md") } },
        })
      ).decision,
    ).toBe("allow")

    // 批准后进入 executing 阶段放行源码编辑
    await writeWorkflowState(repo, "executing", ".clean-arch/plan.md")
    expect(
      (
        await evaluatePreToolUse({
          cwd: repo,
          toolCall: { name: "edit_file", args: { Path: path.join(repo, "shop/core/pricing.py") } },
        })
      ).decision,
    ).toBe("allow")

    // Windows 盘符大小写差异不得绕过只读门禁，且陈旧超时状态自动失效不永久锁仓
    await writeWorkflowState(repo, "awaiting_approval", ".clean-arch/plan.md")
    if (process.platform === "win32" && /^[A-Za-z]:/.test(repo)) {
      const flippedRoot = (repo[0] === repo[0].toLowerCase() ? repo[0].toUpperCase() : repo[0].toLowerCase()) + repo.slice(1)
      const caseCheck = await evaluatePreToolUse({
        cwd: flippedRoot,
        toolCall: { name: "edit_file", args: { Path: path.join(repo, "shop/core/pricing.py") } },
      })
      expect(caseCheck.decision).toBe("deny")
    }

    writeFileSync(
      path.join(repo, ".clean-arch", "state.json"),
      JSON.stringify({ phase: "diagnose", doc: ".clean-arch/plan.md", updatedAt: "2020-01-01T00:00:00.000Z" }),
    )
    expect(
      (
        await evaluatePreToolUse({
          cwd: repo,
          toolCall: { name: "edit_file", args: { Path: path.join(repo, "shop/core/pricing.py") } },
        })
      ).decision,
    ).toBe("allow")
  })
})
