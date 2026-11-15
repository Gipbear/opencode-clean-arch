import path from "node:path"
import { Marked, type Tokens } from "marked"
import { diagramWarnings, mermaidToSvg } from "../render.ts"

const SAFE_TAG = /^<\/?(sub|sup|br|kbd|b|i|em|strong|code|details|summary|p|hr)\s*\/?>$/i

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * Render review Markdown to HTML.
 *
 * Mermaid fences become inline SVG, relative images are served through `/file/` from the
 * project root, and raw HTML is escaped except for a few attribute-free formatting tags.
 * Renderer warnings for each diagram are appended to `warnings`.
 */
export function renderMarkdown(markdown: string, docDir: string, token: string, warnings: string[] = []): string {
  const marked = new Marked({ gfm: true })
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
        const src = /^(https?:|data:)/.test(href)
          ? href
          : `/file/${encodeURI(path.posix.normalize(path.posix.join(docDir, href)))}?t=${token}`
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ""
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
