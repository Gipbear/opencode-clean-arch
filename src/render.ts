import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { renderMermaidSVG } from "beautiful-mermaid"

const FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"

/**
 * Render Mermaid source to a self-contained SVG.
 *
 * beautiful-mermaid emits CSS custom properties, color-mix() and a web-font @import.
 * Code hosts show SVGs through <img>, where remote fonts never load, and some viewers
 * (IDE previews, document converters) do not support custom properties, so colours are
 * resolved to literals here.
 */
export function mermaidToSvg(source: string): string {
  // Mermaid writes generics as list~Fact~; beautiful-mermaid prints the tildes literally.
  const text = /^\s*classDiagram/.test(source) ? source.replace(/~([^~\n]+)~/g, "<$1>") : source
  return flattenSvg(renderMermaidSVG(text, { bg: "#FFFFFF", fg: "#27272A", muted: "#52525B" }))
}

/** Constructs beautiful-mermaid accepts without error but draws wrongly or ignores. */
const UNSUPPORTED: { pattern: RegExp; message: string }[] = [
  { pattern: /^\s*\S+\s+(?:o--|--o|\*--|--\*)\s/m, message: "class diagram `o--`/`*--` diamonds are hidden under the box; use a labelled `-->`" },
  { pattern: /^\s*autonumber\b/m, message: "`autonumber` is ignored; number messages in their labels" },
  { pattern: /^\s*rect\s+rgba?\(/m, message: "`rect rgb(...)` is drawn as a frame labelled with the colour; drop it" },
  { pattern: /~~~/, message: "invisible links `~~~` are ignored" },
  { pattern: /^\s*linkStyle\b/m, message: "`linkStyle` is ignored; mark nodes with classDef/class instead" },
  { pattern: /^\s*subgraph\s+[^\s\[]*[^\x00-\x7F]/m, message: "non-ASCII subgraph ids break the layout; write `subgraph id[\"标题\"]`" },
  { pattern: /<-->|<-\.->|<==>/, message: "two-way arrows are drawn with one head; use two edges" },
  { pattern: /-\.[^.>|\s-][^\n]*?\.->/, message: "dotted links with inline text (`-.text.->`) are dropped; write `-.->|text|`" },
]

const MAX_WIDTH = 1200
const MAX_ASPECT = 3

/** Warnings about syntax the renderer mishandles and about SVGs too wide to read on a code host. */
export function diagramWarnings(source: string, svg: string): string[] {
  const warnings = UNSUPPORTED.filter((u) => u.pattern.test(source)).map((u) => u.message)
  const box = svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/)
  if (box) {
    const [width, height] = [Number(box[1]), Number(box[2])]
    if (width > MAX_WIDTH) warnings.push(`${Math.round(width)} px wide (> ${MAX_WIDTH}); stack subgraphs top-down`)
    else if (width / height > MAX_ASPECT) warnings.push(`aspect ratio ${(width / height).toFixed(1)}:1; stack subgraphs top-down`)
  }
  return warnings
}

export function flattenSvg(svg: string): string {
  let out = svg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*@import[^\n]*\n/gm, "")
  const vars = new Map<string, string>()
  for (const match of out.matchAll(/(--[\w-]+)\s*:\s*([^;"}]+)/g)) {
    if (!vars.has(match[1])) vars.set(match[1], match[2].trim())
  }
  out = out
    .replace(/\n?\s*svg\s*\{[^}]*\}/, "")
    .replace(/(text\s*\{\s*font-family:)[^;}]*/, `$1 ${FONT}`)
    .replace(/(\.mono\s*\{\s*font-family:)[^;}]*/, `$1 ${MONO}`)
    .replace(/style="([^"]*--[^"]*)"/, (_, decls: string) => {
      const kept = decls.split(";").filter((d) => d.trim() && !d.trim().startsWith("--"))
      return `style="${kept.join(";")}"`
    })
  return resolveCss(out, vars)
}

function resolveCss(text: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 12) return text
  const withVars = replaceCalls(text, "var", (args) => {
    const [name, ...fallback] = splitTopLevel(args)
    const value = vars.get(name.trim())
    return resolveCss(value ?? fallback.join(",").trim(), vars, depth + 1)
  })
  return replaceCalls(withVars, "color-mix", mixColors)
}

function replaceCalls(text: string, fn: string, replace: (args: string) => string): string {
  const open = `${fn}(`
  let result = ""
  let index = 0
  while (true) {
    const start = text.indexOf(open, index)
    if (start < 0) return result + text.slice(index)
    if (start > 0 && /[\w-]/.test(text[start - 1])) {
      result += text.slice(index, start + open.length)
      index = start + open.length
      continue
    }
    let level = 1
    let end = start + open.length
    while (end < text.length && level > 0) {
      if (text[end] === "(") level++
      else if (text[end] === ")") level--
      end++
    }
    result += text.slice(index, start) + replace(text.slice(start + open.length, end - 1))
    index = end
  }
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = []
  let level = 0
  let current = ""
  for (const ch of args) {
    if (ch === "(") level++
    if (ch === ")") level--
    if (ch === "," && level === 0) {
      parts.push(current)
      current = ""
    } else current += ch
  }
  parts.push(current)
  return parts
}

function mixColors(args: string): string {
  const [, first, second] = splitTopLevel(args).map((s) => s.trim())
  const a = parseStop(first)
  const b = parseStop(second)
  if (!a.rgb || !b.rgb) return `color-mix(${args})`
  const wa = a.pct ?? (b.pct !== undefined ? 100 - b.pct : 50)
  const channel = (i: number) => Math.round((a.rgb![i] * wa + b.rgb![i] * (100 - wa)) / 100)
  return "#" + [0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")
}

function parseStop(stop: string): { rgb?: number[]; pct?: number } {
  const match = stop.match(/^(#[0-9a-fA-F]{3,8})\s*(?:(\d+(?:\.\d+)?)%)?$/)
  if (!match) return {}
  let hex = match[1].slice(1)
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("")
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return { rgb, pct: match[2] !== undefined ? Number(match[2]) : undefined }
}

export interface RenderResult {
  rendered: string[]
  skipped: string[]
  failed: { file: string; error: string }[]
  warnings: { file: string; message: string }[]
}

/** Render every `.mmd` file under `target` (a file or directory) to an `.svg` next to it. */
export async function renderDiagrams(target: string, force = false): Promise<RenderResult> {
  const result: RenderResult = { rendered: [], skipped: [], failed: [], warnings: [] }
  for (const file of await findMermaidFiles(target)) {
    const svgPath = file.replace(/\.mmd$/, ".svg")
    if (!force && (await isUpToDate(file, svgPath))) {
      result.skipped.push(svgPath)
      continue
    }
    try {
      const source = await readFile(file, "utf8")
      const svg = mermaidToSvg(source)
      await writeFile(svgPath, svg + "\n")
      result.rendered.push(svgPath)
      for (const message of diagramWarnings(source, svg)) result.warnings.push({ file, message })
    } catch (error) {
      result.failed.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

async function findMermaidFiles(target: string): Promise<string[]> {
  const info = await stat(target)
  if (info.isFile()) return target.endsWith(".mmd") ? [target] : []
  const files: string[] = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) files.push(...(await findMermaidFiles(full)))
    else if (entry.name.endsWith(".mmd")) files.push(full)
  }
  return files.sort()
}

async function isUpToDate(source: string, output: string): Promise<boolean> {
  try {
    return (await stat(output)).mtimeMs >= (await stat(source)).mtimeMs
  } catch {
    return false
  }
}
