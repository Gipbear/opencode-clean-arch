import { readFileSync } from "node:fs"
import path from "node:path"
import { Marked, type Tokens } from "marked"
import { diagramWarnings, mermaidToSvg } from "../render.ts"
import { isPathInside } from "./state.ts"

const SAFE_TAG = /^<\/?(sub|sup|br|kbd|b|i|em|strong|code|details|summary|p|hr)\s*\/?>$/i
const INLINE_IMAGE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
const MAX_INLINE_IMAGE_BYTES = 1_500_000

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

export interface RenderMarkdownOptions {
  /** HTTP 模式下通过 `/file/` 路由加载图片；inline 模式将本地图片内联为 data URI（适用于 MCP App 隔离 iframe）。 */
  imageMode?: "http" | "inline"
  /** inline 模式下用于安全解析本地图片路径的仓库根目录。 */
  rootDir?: string
}

function tryInlineLocalImage(rootDir: string, docDir: string, href: string): string | null {
  const resolvedRoot = path.resolve(rootDir)
  let cleanHref = href.split(/[?#]/)[0].replace(/\\/g, "/")
  try {
    cleanHref = decodeURIComponent(cleanHref)
  } catch {
    // 非法百分号序列保持原样交由路径解析检查
  }
  const rel = path.posix.normalize(path.posix.join(docDir.replace(/\\/g, "/"), cleanHref))
  const full = path.resolve(resolvedRoot, rel)
  const mime = INLINE_IMAGE_TYPES[path.extname(full).toLowerCase()]
  if (!mime || !isPathInside(resolvedRoot, full)) return null
  try {
    const buf = readFileSync(full)
    if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) return null
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

/**
 * 将评审 Markdown 渲染为 HTML。
 *
 * Mermaid 代码块转为内联 SVG；相对路径图片在 HTTP 模式下通过 `/file/` 提供，在 inline 模式下转为 data URI；
 * 除少量无属性格式标签外，其余原始 HTML 均做转义处理。各图表渲染警告追加至 `warnings`。
 */
export function renderMarkdown(
  markdown: string,
  docDir: string,
  token: string,
  warnings: string[] = [],
  options: RenderMarkdownOptions = {},
): string {
  const marked = new Marked({ gfm: true })
  const imageMode = options.imageMode ?? "http"
  marked.use({
    renderer: {
      code({ text, lang }: Tokens.Code) {
        if ((lang ?? "").trim() === "mermaid") {
          try {
            const svg = mermaidToSvg(text)
            const first = text.trim().split("\n")[0]
            for (const message of diagramWarnings(text, svg)) warnings.push(`diagram "${first}…": ${message}`)
            return `<figure class="diagram">${svg}</figure>`
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return `<div class="diagram-error">Mermaid 渲染失败: ${escapeHtml(message)}</div><pre><code>${escapeHtml(text)}</code></pre>`
          }
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        const parts = text.split(/(<[^>]+>)/).filter(Boolean)
        return parts.map((part) => (part.startsWith("<") && SAFE_TAG.test(part) ? part : escapeHtml(part))).join("")
      },
      image({ href, title, text }: Tokens.Image) {
        let src: string
        if (/^(https?:|data:)/.test(href)) {
          src = href
        } else if (imageMode === "inline" && options.rootDir) {
          src = tryInlineLocalImage(options.rootDir, docDir, href) ?? ""
        } else {
          src = `/file/${encodeURI(path.posix.normalize(path.posix.join(docDir, href)))}?t=${token}`
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
        if (!src) return `<span class="local-link">[图片无法内联: ${escapeHtml(text || href)}]</span>`
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const safe = /^(https?:|mailto:|#)/.test(href)
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
        return safe
          ? `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer">${inner}</a>`
          : `<span class="local-link" title="${escapeHtml(href)}">${inner}</span>`
      },
    },
  })
  return marked.parse(markdown, { async: false }) as string
}
