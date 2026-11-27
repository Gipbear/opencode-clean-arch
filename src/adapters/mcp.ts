import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { DIST_DIR } from "../paths.ts"
import {
  commitReviewDecision,
  enterReviewState,
  formatOutcome,
  normalizeAnnotations,
  prepareReviewDocument,
  resolveProjectFile,
  saveReviewDraft,
} from "../review/store.ts"
import { TOOLS, toZodShape, type ToolEnv } from "../tools.ts"

export const REVIEW_APP_URI = "ui://clean-arch/review.html"

const NON_UI_CLIENT_RE = /(cursor|claude|codex|opencode|windsurf|cline|zed)/i

function panelKey(root: string, relFile: string): string {
  const normRoot = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)
  return `${normRoot}::${relFile}`
}

function defaultReviewAction(server: McpServer): "panel" | "open" {
  try {
    const caps = server.server.getClientCapabilities()
    if (getUiCapability(caps)) return "panel"
    const clientName = server.server.getClientVersion()?.name ?? ""
    if (NON_UI_CLIENT_RE.test(clientName)) return "open"
  } catch {
    // 忽略握手前或异常读取，默认保持 panel
  }
  return "panel"
}

/** 解析目标仓库根目录：显式参数 > MCP Client roots > 当前工作目录。 */
async function resolveWorkspaceRoot(server: McpServer, explicitRoot?: string): Promise<string> {
  if (explicitRoot && explicitRoot.trim()) {
    return path.resolve(explicitRoot.trim())
  }
  try {
    const caps = server.server.getClientCapabilities()
    if (caps?.roots) {
      const res = await server.server.listRoots()
      for (const item of res.roots ?? []) {
        if (item.uri.startsWith("file://")) {
          return fileURLToPath(item.uri)
        }
      }
    }
  } catch {
    // 客户端不支持 roots/list 时回退到进程 cwd
  }
  return process.cwd()
}

async function loadReviewAppHtml(): Promise<string> {
  const custom = process.env.CLEAN_ARCH_REVIEW_APP_HTML
  const target = custom ? path.resolve(custom) : path.join(DIST_DIR, "review-app.html")
  return readFile(target, "utf8")
}

/** 创建配置好全部 clean-arch 工具与 Antigravity MCP App 资源的 McpServer 实例。 */
export function createCleanArchMcpServer(): McpServer {
  const server = new McpServer({
    name: "clean-arch",
    version: "0.4.4",
  })
  const panelTokens = new Map<string, string>()

  // 注册 Antigravity MCP App 单文件 HTML 资源
  registerAppResource(
    server,
    "架构评审面板",
    REVIEW_APP_URI,
    {
      description: "Clean-Arch 交互式架构方案评审面板（支持划线批注、版本 Diff 与结论回传）",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [
        {
          uri: REVIEW_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadReviewAppHtml(),
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    }),
  )

  // 注册除 review 外的 4 个分析/渲染/扫描/性能工具（复用 src/tools.ts 统一定义）
  for (const spec of TOOLS) {
    if (spec.name === "clean_arch_review") continue
    const shape = {
      ...toZodShape(z, spec.params),
      root: z
        .string()
        .optional()
        .describe("目标仓库根目录的绝对路径（未传时优先读取 MCP 工作区 root 或当前目录）"),
    }
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: shape as any,
      },
      async (args: any, extra: any) => {
        const directory = await resolveWorkspaceRoot(server, args?.root)
        const env: ToolEnv = {
          directory,
          signal: extra?.signal,
          progress: () => {},
        }
        const text = await spec.execute(args ?? {}, env)
        return { content: [{ type: "text" as const, text }] }
      },
    )
  }

  // 注册 clean_arch_review：默认启用 Antigravity MCP App 侧边栏面板，并兼容 HTTP open/wait 模式
  const reviewSpec = TOOLS.find((t) => t.name === "clean_arch_review")!
  registerAppTool(
    server,
    "clean_arch_review",
    {
      title: "架构方案评审",
      description:
        reviewSpec.description +
        " In Antigravity, action=panel (default) opens the interactive review panel directly in the side pane " +
        "without blocking; use action=open/wait only in CLI or hosts without MCP App UI.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("待评审的 Markdown 文件（默认 .clean-arch/plan.md）"),
        action: z
          .enum(["panel", "open", "wait"])
          .optional()
          .describe("panel (默认，Antigravity 侧边栏评审面板) | open (本地 HTTP 网页) | wait (阻塞等待 HTTP 提交)"),
        title: z.string().optional().describe("评审页面标题（默认取文档首个一级标题）"),
        root: z
          .string()
          .optional()
          .describe("目标仓库根目录的绝对路径（未传时优先读取 MCP 工作区 root 或当前目录）"),
      } as any,
      _meta: {
        ui: {
          resourceUri: REVIEW_APP_URI,
          visibility: ["model", "app"],
        },
        "com.google.antigravity/ui": {
          entrypoints: [{ type: "aux_pane", title: "架构评审" }],
        },
      },
    },
    async (args: any, extra: any) => {
      const directory = await resolveWorkspaceRoot(server, args?.root)
      const targetFile = typeof args?.path === "string" && args.path.trim() ? args.path.trim() : ".clean-arch/plan.md"
      const action = args?.action ?? defaultReviewAction(server)

      if (action === "open" || action === "wait") {
        const env: ToolEnv = { directory, signal: extra?.signal, progress: () => {} }
        const text = await reviewSpec.execute({ ...args, path: targetFile, action }, env)
        return { content: [{ type: "text" as const, text }] }
      }

      // action === "panel": 准备轻量化数据并在 Antigravity 侧边栏打开 MCP App
      let resolved: { root: string; full: string; relFile: string }
      try {
        resolved = resolveProjectFile(directory, targetFile)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          isError: true,
          content: [{ type: "text" as const, text: msg }],
          structuredContent: { mode: "empty", root: directory, file: targetFile, message: msg },
        }
      }

      if (!existsSync(resolved.full)) {
        const msg = `未找到待评审文档 ${resolved.relFile}（工作区：${resolved.root}）。请先运行 /clean-arch 或 /arch-plan 生成方案。`
        return {
          content: [{ type: "text" as const, text: msg }],
          structuredContent: { mode: "empty", root: resolved.root, file: resolved.relFile, message: msg },
        }
      }

      const prepared = await prepareReviewDocument({
        root: resolved.root,
        file: resolved.relFile,
        title: args?.title,
        imageMode: "inline",
      })
      panelTokens.set(panelKey(prepared.root, prepared.relFile), randomBytes(16).toString("hex"))
      await enterReviewState(prepared.root, prepared.relFile)

      const warningNote = prepared.diagramWarnings.length
        ? `\n\nDiagram warnings:\n${prepared.diagramWarnings.map((w) => `- ${w}`).join("\n")}`
        : ""

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Interactive review panel opened in side pane for ${prepared.relFile} (Revision ${prepared.page.revision}). ` +
              `Stop editing source code and wait for the user's review decision message from the panel.` +
              ` If this host does not render MCP Apps, call clean_arch_review again with action="open".` +
              warningNote,
          },
        ],
        // 保持 trajectory payload 轻量，由 UI 挂载后调用 review_app_load 拉取完整 HTML/Diff 与 uiToken
        structuredContent: {
          mode: "review",
          root: prepared.root,
          file: prepared.relFile,
          title: prepared.page.title,
          revision: prepared.page.revision,
        },
      }
    },
  )

  // App-Only 工具 1：加载完整评审文档、内联图片、Diff 与实时草稿
  registerAppTool(
    server,
    "review_app_load",
    {
      description: "[INTERNAL UI CALLBACK — DO NOT CALL FROM MODEL] Load full rendered review document, diff and draft for MCP App UI",
      inputSchema: {
        root: z.string(),
        file: z.string(),
        title: z.string().optional(),
      } as any,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: any) => {
      const prepared = await prepareReviewDocument({
        root: args.root,
        file: args.file,
        title: args.title,
        imageMode: "inline",
      })
      const key = panelKey(prepared.root, prepared.relFile)
      let uiToken = panelTokens.get(key)
      if (!uiToken) {
        uiToken = randomBytes(16).toString("hex")
        panelTokens.set(key, uiToken)
      }
      return {
        content: [{ type: "text" as const, text: `Loaded ${prepared.relFile} rev ${prepared.page.revision}` }],
        structuredContent: {
          mode: "review",
          root: prepared.root,
          file: prepared.relFile,
          title: prepared.page.title,
          revision: prepared.page.revision,
          html: prepared.page.html,
          diff: prepared.page.diff,
          previous: prepared.page.previous,
          draft: prepared.draft,
          uiToken,
        },
      }
    },
  )

  // App-Only 工具 2：实时保存批注草稿（突破 iframe 重载不保留 localStorage 限制）
  registerAppTool(
    server,
    "review_app_save_draft",
    {
      description: "[INTERNAL UI CALLBACK — DO NOT CALL FROM MODEL] Persist review draft annotations and comment",
      inputSchema: {
        root: z.string(),
        file: z.string(),
        revision: z.number(),
        draft: z.object({
          comment: z.string().default(""),
          annotations: z.array(z.any()).default([]),
        }),
      } as any,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: any) => {
      await saveReviewDraft(args.root, args.file, args.revision, args.draft)
      return { content: [{ type: "text" as const, text: "saved" }] }
    },
  )

  // App-Only 工具 3：提交正式评审结论、更新工作流阶段并返回格式化结果
  registerAppTool(
    server,
    "review_app_submit",
    {
      description: "[INTERNAL UI CALLBACK — DO NOT CALL FROM MODEL] Commit final human review decision from MCP App UI",
      inputSchema: {
        root: z.string(),
        file: z.string(),
        revision: z.number(),
        decision: z.enum(["approved", "approved_with_notes", "changes_requested"]),
        comment: z.string().default(""),
        annotations: z.array(z.any()).default([]),
        uiToken: z.string().optional(),
      } as any,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (args: any) => {
      const resolved = resolveProjectFile(args.root, args.file)
      const key = panelKey(resolved.root, resolved.relFile)
      const expectedToken = panelTokens.get(key)
      if (!expectedToken || !args.uiToken || args.uiToken !== expectedToken) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Refused: review decisions must be submitted by the human reviewer inside the UI panel, never called directly by the model.",
            },
          ],
        }
      }
      panelTokens.delete(key)
      const outcome = await commitReviewDecision({
        root: resolved.root,
        file: resolved.relFile,
        revision: args.revision,
        decision: args.decision,
        comment: String(args.comment ?? ""),
        annotations: normalizeAnnotations(args.annotations),
        url: REVIEW_APP_URI,
      })
      const formatted = formatOutcome(outcome)
      return {
        content: [{ type: "text" as const, text: formatted }],
        structuredContent: {
          decision: outcome.decision,
          revision: outcome.revision,
          record: outcome.record,
          formatted,
        },
      }
    },
  )

  return server
}

/** 启动 Stdio MCP Server 监听（供 dist/mcp.js 入口调用，无模块加载副作用）。 */
export async function runMcpStdio(): Promise<void> {
  const server = createCleanArchMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
