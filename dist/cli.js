#!/usr/bin/env node

// <stdin>
import path5 from "node:path";

// src/render.ts
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderMermaidSVG } from "beautiful-mermaid";
var FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
var MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
function mermaidToSvg(source) {
  const text = /^\s*classDiagram/.test(source) ? source.replace(/~([^~\n]+)~/g, "<$1>") : source;
  return flattenSvg(renderMermaidSVG(text, { bg: "#FFFFFF", fg: "#27272A", muted: "#52525B" }));
}
var UNSUPPORTED = [
  { pattern: /^\s*\S+\s+(?:o--|--o|\*--|--\*)\s/m, message: "class diagram `o--`/`*--` diamonds are hidden under the box; use a labelled `-->`" },
  { pattern: /^\s*autonumber\b/m, message: "`autonumber` is ignored; number messages in their labels" },
  { pattern: /^\s*rect\s+rgba?\(/m, message: "`rect rgb(...)` is drawn as a frame labelled with the colour; drop it" },
  { pattern: /~~~/, message: "invisible links `~~~` are ignored" },
  { pattern: /^\s*linkStyle\b/m, message: "`linkStyle` is ignored; mark nodes with classDef/class instead" },
  { pattern: /^\s*subgraph\s+[^\s\[]*[^\x00-\x7F]/m, message: 'non-ASCII subgraph ids break the layout; write `subgraph id["\u6807\u9898"]`' },
  { pattern: /<-->|<-\.->|<==>/, message: "two-way arrows are drawn with one head; use two edges" },
  { pattern: /-\.[^.>|\s-][^\n]*?\.->/, message: "dotted links with inline text (`-.text.->`) are dropped; write `-.->|text|`" }
];
var MAX_WIDTH = 1200;
var MAX_ASPECT = 3;
function diagramWarnings(source, svg) {
  const warnings = UNSUPPORTED.filter((u) => u.pattern.test(source)).map((u) => u.message);
  const box = svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
  if (box) {
    const [width, height] = [Number(box[1]), Number(box[2])];
    if (width > MAX_WIDTH) warnings.push(`${Math.round(width)} px wide (> ${MAX_WIDTH}); stack subgraphs top-down`);
    else if (width / height > MAX_ASPECT) warnings.push(`aspect ratio ${(width / height).toFixed(1)}:1; stack subgraphs top-down`);
  }
  return warnings;
}
function flattenSvg(svg) {
  let out = svg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*@import[^\n]*\n/gm, "");
  const vars = /* @__PURE__ */ new Map();
  for (const match of out.matchAll(/(--[\w-]+)\s*:\s*([^;"}]+)/g)) {
    if (!vars.has(match[1])) vars.set(match[1], match[2].trim());
  }
  out = out.replace(/\n?\s*svg\s*\{[^}]*\}/, "").replace(/(text\s*\{\s*font-family:)[^;}]*/, `$1 ${FONT}`).replace(/(\.mono\s*\{\s*font-family:)[^;}]*/, `$1 ${MONO}`).replace(/style="([^"]*--[^"]*)"/, (_, decls) => {
    const kept = decls.split(";").filter((d) => d.trim() && !d.trim().startsWith("--"));
    return `style="${kept.join(";")}"`;
  });
  return resolveCss(out, vars);
}
function resolveCss(text, vars, depth = 0) {
  if (depth > 12) return text;
  const withVars = replaceCalls(text, "var", (args) => {
    const [name, ...fallback] = splitTopLevel(args);
    const value = vars.get(name.trim());
    return resolveCss(value ?? fallback.join(",").trim(), vars, depth + 1);
  });
  return replaceCalls(withVars, "color-mix", mixColors);
}
function replaceCalls(text, fn, replace) {
  const open = `${fn}(`;
  let result = "";
  let index = 0;
  while (true) {
    const start = text.indexOf(open, index);
    if (start < 0) return result + text.slice(index);
    if (start > 0 && /[\w-]/.test(text[start - 1])) {
      result += text.slice(index, start + open.length);
      index = start + open.length;
      continue;
    }
    let level = 1;
    let end = start + open.length;
    while (end < text.length && level > 0) {
      if (text[end] === "(") level++;
      else if (text[end] === ")") level--;
      end++;
    }
    result += text.slice(index, start) + replace(text.slice(start + open.length, end - 1));
    index = end;
  }
}
function splitTopLevel(args) {
  const parts = [];
  let level = 0;
  let current = "";
  for (const ch of args) {
    if (ch === "(") level++;
    if (ch === ")") level--;
    if (ch === "," && level === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}
function mixColors(args) {
  const [, first, second] = splitTopLevel(args).map((s) => s.trim());
  const a = parseStop(first);
  const b = parseStop(second);
  if (!a.rgb || !b.rgb) return `color-mix(${args})`;
  const wa = a.pct ?? (b.pct !== void 0 ? 100 - b.pct : 50);
  const channel = (i) => Math.round((a.rgb[i] * wa + b.rgb[i] * (100 - wa)) / 100);
  return "#" + [0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("");
}
function parseStop(stop) {
  const match = stop.match(/^(#[0-9a-fA-F]{3,8})\s*(?:(\d+(?:\.\d+)?)%)?$/);
  if (!match) return {};
  let hex = match[1].slice(1);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { rgb, pct: match[2] !== void 0 ? Number(match[2]) : void 0 };
}
async function renderDiagrams(target, force = false) {
  const result = { rendered: [], skipped: [], failed: [], warnings: [] };
  for (const file of await findMermaidFiles(target)) {
    const svgPath = file.replace(/\.mmd$/, ".svg");
    if (!force && await isUpToDate(file, svgPath)) {
      result.skipped.push(svgPath);
      continue;
    }
    try {
      const source = await readFile(file, "utf8");
      const svg = mermaidToSvg(source);
      await writeFile(svgPath, svg + "\n");
      result.rendered.push(svgPath);
      for (const message of diagramWarnings(source, svg)) result.warnings.push({ file, message });
    } catch (error) {
      result.failed.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
async function findMermaidFiles(target) {
  const info = await stat(target);
  if (info.isFile()) return target.endsWith(".mmd") ? [target] : [];
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await findMermaidFiles(full));
    else if (entry.name.endsWith(".mmd")) files.push(full);
  }
  return files.sort();
}
async function isUpToDate(source, output) {
  try {
    return (await stat(output)).mtimeMs >= (await stat(source)).mtimeMs;
  } catch {
    return false;
  }
}

// src/review/server.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";

// src/review/markdown.ts
import { readFileSync } from "node:fs";
import path3 from "node:path";
import { Marked } from "marked";

// src/review/state.ts
import { mkdir, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import path2 from "node:path";
var VALID_PHASES = /* @__PURE__ */ new Set(["diagnose", "awaiting_approval", "executing", "done"]);
function isPathInside(rootDir, targetPath, allowSame = false) {
  const base = path2.resolve(rootDir);
  const full = path2.resolve(base, targetPath);
  const normBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normFull = process.platform === "win32" ? full.toLowerCase() : full;
  if (normBase === normFull) return allowSame;
  const rel = path2.relative(normBase, normFull);
  return Boolean(rel) && !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function stateFilePath(root) {
  const resolvedRoot = path2.resolve(root);
  const target = path2.resolve(resolvedRoot, ".clean-arch", "state.json");
  if (!isPathInside(resolvedRoot, target)) {
    throw new Error("Invalid state file path outside workspace root");
  }
  return target;
}
async function readWorkflowState(root) {
  try {
    const raw = await readFile2(stateFilePath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.phase || !VALID_PHASES.has(parsed.phase)) return null;
    return {
      phase: parsed.phase,
      doc: typeof parsed.doc === "string" ? parsed.doc : void 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
    };
  } catch {
    return null;
  }
}
async function writeWorkflowState(root, phase, doc) {
  const file = stateFilePath(root);
  await mkdir(path2.dirname(file), { recursive: true });
  const state = {
    phase,
    ...doc ? { doc } : {},
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeFile2(file, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// src/review/markdown.ts
var SAFE_TAG = /^<\/?(sub|sup|br|kbd|b|i|em|strong|code|details|summary|p|hr)\s*\/?>$/i;
var INLINE_IMAGE_TYPES = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
var MAX_INLINE_IMAGE_BYTES = 15e5;
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function tryInlineLocalImage(rootDir, docDir, href) {
  const resolvedRoot = path3.resolve(rootDir);
  let cleanHref = href.split(/[?#]/)[0].replace(/\\/g, "/");
  try {
    cleanHref = decodeURIComponent(cleanHref);
  } catch {
  }
  const rel = path3.posix.normalize(path3.posix.join(docDir.replace(/\\/g, "/"), cleanHref));
  const full = path3.resolve(resolvedRoot, rel);
  const mime = INLINE_IMAGE_TYPES[path3.extname(full).toLowerCase()];
  if (!mime || !isPathInside(resolvedRoot, full)) return null;
  try {
    const buf = readFileSync(full);
    if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
function renderMarkdown(markdown, docDir, token, warnings = [], options = {}) {
  const marked = new Marked({ gfm: true });
  const imageMode = options.imageMode ?? "http";
  marked.use({
    renderer: {
      code({ text, lang }) {
        if ((lang ?? "").trim() === "mermaid") {
          try {
            const svg = mermaidToSvg(text);
            const first = text.trim().split("\n")[0];
            for (const message of diagramWarnings(text, svg)) warnings.push(`diagram "${first}\u2026": ${message}`);
            return `<figure class="diagram">${svg}</figure>`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `<div class="diagram-error">Mermaid \u6E32\u67D3\u5931\u8D25: ${escapeHtml(message)}</div><pre><code>${escapeHtml(text)}</code></pre>`;
          }
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      },
      html({ text }) {
        const parts = text.split(/(<[^>]+>)/).filter(Boolean);
        return parts.map((part) => part.startsWith("<") && SAFE_TAG.test(part) ? part : escapeHtml(part)).join("");
      },
      image({ href, title, text }) {
        let src;
        if (/^(https?:|data:)/.test(href)) {
          src = href;
        } else if (imageMode === "inline" && options.rootDir) {
          src = tryInlineLocalImage(options.rootDir, docDir, href) ?? "";
        } else {
          src = `/file/${encodeURI(path3.posix.normalize(path3.posix.join(docDir, href)))}?t=${token}`;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        if (!src) return `<span class="local-link">[\u56FE\u7247\u65E0\u6CD5\u5185\u8054: ${escapeHtml(text || href)}]</span>`;
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const safe = /^(https?:|mailto:|#)/.test(href);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return safe ? `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer">${inner}</a>` : `<span class="local-link" title="${escapeHtml(href)}">${inner}</span>`;
      }
    }
  });
  return marked.parse(markdown, { async: false });
}

// src/review/page.ts
function renderPage(data) {
  const { html, ...clientData } = data;
  const json = JSON.stringify(clientData).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} \xB7 \u65B9\u6848\u8BC4\u5BA1</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="title">
    <h1>${escapeHtml(data.title)}</h1>
    <div class="meta"><code>${escapeHtml(data.file)}</code> \xB7 \u7B2C ${data.revision} \u7248</div>
  </div>
  <nav class="tabs">
    <button class="tab active" data-tab="doc">\u6587\u6863</button>
    <button class="tab" data-tab="diff" ${data.diff ? "" : "hidden"}>\u4E0E\u4E0A\u4E00\u7248\u5DEE\u5F02 <span id="diff-stats"></span></button>
  </nav>
  <div class="actions">
    <button class="btn danger" data-decision="changes_requested">\u8981\u6C42\u4FEE\u6539</button>
    <button class="btn" data-decision="approved_with_notes">\u6279\u51C6\u5E76\u9644\u610F\u89C1</button>
    <button class="btn primary" data-decision="approved">\u6279\u51C6</button>
  </div>
</header>
<main class="layout">
  <section class="pane" id="pane-doc">
    <p class="hint">\u9009\u4E2D\u6587\u5B57\u53EF\u4EE5\u6DFB\u52A0<b>\u8BC4\u8BBA</b>\u3001<b>\u5220\u9664</b>\u6216<b>\u66FF\u6362</b>\u5EFA\u8BAE\uFF1B\u53F3\u4FA7\u586B\u5199\u603B\u4F53\u610F\u89C1\u540E\u9009\u62E9\u8BC4\u5BA1\u7ED3\u8BBA\u3002</p>
    <article id="doc" class="markdown">${html}</article>
  </section>
  <section class="pane" id="pane-diff" hidden>
    <div id="diff" class="diff"></div>
  </section>
  <aside class="sidebar">
    <h2>\u6279\u6CE8 <span id="count" class="count">0</span></h2>
    <p id="empty" class="empty">\u8FD8\u6CA1\u6709\u6279\u6CE8\u3002\u5728\u6587\u6863\u4E2D\u9009\u4E2D\u6587\u5B57\u5F00\u59CB\u3002</p>
    <ol id="annotations" class="annotations"></ol>
    <label class="general">
      <span>\u603B\u4F53\u610F\u89C1</span>
      <textarea id="comment" rows="5" placeholder="\u5BF9\u6574\u4EFD\u65B9\u6848\u7684\u610F\u89C1\uFF08\u53EF\u9009\uFF09"></textarea>
    </label>
    <div id="previous"></div>
  </aside>
</main>
<div id="toolbar" class="toolbar" hidden>
  <button data-kind="comment">\u8BC4\u8BBA</button>
  <button data-kind="delete">\u5220\u9664</button>
  <button data-kind="replace">\u66FF\u6362</button>
</div>
<div id="popover" class="popover" hidden>
  <div class="popover-quote" id="popover-quote"></div>
  <textarea id="popover-text" rows="4"></textarea>
  <div class="popover-actions">
    <button class="btn" id="popover-cancel">\u53D6\u6D88</button>
    <button class="btn primary" id="popover-save">\u6DFB\u52A0</button>
  </div>
</div>
<div id="done" class="done" hidden>
  <div class="done-card">
    <h2 id="done-title">\u5DF2\u63D0\u4EA4</h2>
    <p>\u8BC4\u5BA1\u7ED3\u679C\u5DF2\u53D1\u9001\u7ED9 Agent\uFF0C\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\u56DE\u5230\u5BF9\u8BDD\u7A97\u53E3\u3002</p>
  </div>
</div>
<div id="toast" class="toast" hidden></div>
<script type="application/json" id="data">${json}</script>
<script>${CLIENT}</script>
</body>
</html>`;
}
var CSS = String.raw`
:root {
  --bg: #f7f7f8; --panel: #fff; --fg: #1f2328; --muted: #656d76; --line: #e3e5e8;
  --accent: #0f766e; --danger: #c2410c; --comment: #2563eb; --delete: #dc2626; --replace: #d97706;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
.topbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  padding: 10px 20px; background: var(--panel); border-bottom: 1px solid var(--line); }
.title { flex: 1 1 260px; min-width: 0; }
.title h1 { margin: 0; font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
.tabs { display: flex; gap: 4px; }
.tab { border: 0; background: none; padding: 6px 10px; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; font-size: 14px; }
.tab.active { background: #eef1f4; color: var(--fg); font-weight: 600; }
.actions { display: flex; gap: 8px; }
.btn { border: 1px solid var(--line); background: var(--panel); color: var(--fg); padding: 7px 14px; border-radius: 7px;
  font: inherit; font-size: 14px; cursor: pointer; }
.btn:hover { border-color: #c9ced4; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.danger { color: var(--danger); border-color: #f1c7b4; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; max-width: 1280px; margin: 0 auto; padding: 20px; }
.pane { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 24px 32px; min-width: 0; }
.hint { margin: 0 0 16px; padding: 8px 12px; background: #f0fdfa; border-radius: 6px; color: #115e59; font-size: 13px; }
.sidebar { position: sticky; top: 76px; align-self: start; max-height: calc(100vh - 96px); overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
.sidebar h2 { margin: 0 0 8px; font-size: 15px; display: flex; align-items: center; gap: 6px; }
.count { background: #eef1f4; border-radius: 10px; padding: 0 8px; font-size: 12px; }
.empty { color: var(--muted); font-size: 13px; }
.annotations { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.annotation { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
.annotation.flash { outline: 2px solid var(--accent); }
.annotation header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; color: #fff; }
.badge.comment { background: var(--comment); } .badge.delete { background: var(--delete); } .badge.replace { background: var(--replace); }
.section { color: var(--muted); font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.remove { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; }
.quote { margin: 0; padding-left: 8px; border-left: 3px solid var(--line); color: var(--muted); white-space: pre-wrap; word-break: break-word; }
.annotation .text { margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
.general { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; font-size: 14px; font-weight: 600; }
textarea { width: 100%; font: inherit; font-size: 14px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; resize: vertical; }
textarea:focus { outline: 2px solid #99f6e4; border-color: var(--accent); }
.markdown { line-height: 1.7; font-size: 15px; word-wrap: break-word; }
.markdown h1, .markdown h2, .markdown h3 { line-height: 1.3; margin: 1.4em 0 .6em; }
.markdown h1 { font-size: 1.6em; } .markdown h2 { font-size: 1.3em; padding-bottom: .3em; border-bottom: 1px solid var(--line); }
.markdown h3 { font-size: 1.1em; }
.markdown code { background: #f2f4f6; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
.markdown pre { background: #f6f8fa; padding: 12px 14px; border-radius: 8px; overflow: auto; }
.markdown pre code { background: none; padding: 0; }
.markdown table { border-collapse: collapse; display: block; overflow: auto; margin: 1em 0; }
.markdown th, .markdown td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
.markdown th { background: #f6f8fa; }
.markdown blockquote { margin: 1em 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
.markdown img, .diagram svg { max-width: 100%; height: auto; }
.diagram { margin: 1em 0; text-align: center; overflow: auto; }
.diagram-error { color: var(--danger); font-size: 13px; }
.local-link { color: var(--accent); border-bottom: 1px dotted var(--accent); }
mark.ann { border-radius: 2px; cursor: pointer; }
mark.ann-comment { background: #dbeafe; } mark.ann-delete { background: #fee2e2; text-decoration: line-through; }
mark.ann-replace { background: #fef3c7; }
.toolbar { position: absolute; z-index: 20; transform: translateX(-50%); display: flex; background: #1f2328; border-radius: 8px;
  padding: 3px; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
.toolbar button { border: 0; background: none; color: #fff; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; border-radius: 6px; }
.toolbar button:hover { background: #3a4048; }
.popover { position: absolute; z-index: 21; width: min(380px, 92vw); background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.18); }
.popover-quote { font-size: 12px; color: var(--muted); max-height: 80px; overflow: auto; margin-bottom: 8px; white-space: pre-wrap; }
.popover-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.diff { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.diff div { padding: 0 8px; } .diff .add { background: #e6ffec; } .diff .del { background: #ffebe9; text-decoration: line-through; color: #82071e; }
.diff .gap { color: var(--muted); background: #f6f8fa; text-align: center; font-family: inherit; }
.previous { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-top: 16px; font-size: 13px; }
.previous summary { cursor: pointer; font-size: 14px; font-weight: 600; }
.previous ol { padding-left: 18px; }
.done { position: fixed; inset: 0; z-index: 50; background: rgba(247,247,248,.92); display: grid; place-items: center; }
.done-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px 36px; text-align: center; max-width: 420px; }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1f2328; color: #fff; padding: 8px 16px;
  border-radius: 8px; font-size: 14px; z-index: 60; }
[hidden] { display: none !important; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; padding: 12px; }
  .pane { padding: 16px; }
  .sidebar { position: static; max-height: none; }
  .actions { width: 100%; } .actions .btn { flex: 1; padding: 8px 6px; }
}
`;
var CLIENT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var KIND = { comment: "评论", delete: "删除", replace: "替换" };
  var DECISION = { approved: "批准", approved_with_notes: "批准并附意见", changes_requested: "要求修改" };
  var draftKey = "clean-arch-review:" + data.file + ":" + data.revision;
  var state = { annotations: [], comment: "" };
  var pending = null;
  var popoverKind = null;
  var $ = function (id) { return document.getElementById(id); };
  var doc = $("doc"), toolbar = $("toolbar"), popover = $("popover");

  try {
    var saved = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (saved) { state = saved; $("comment").value = state.comment || ""; }
  } catch (e) {}

  function saveDraft() { try { localStorage.setItem(draftKey, JSON.stringify(state)); } catch (e) {} }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(message) {
    var t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function sectionOf(node) {
    var target = node.nodeType === 1 ? node : node.parentElement;
    var stack = [];
    var heads = doc.querySelectorAll("h1, h2, h3, h4");
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var before = h.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (!before && !h.contains(target)) break;
      var level = Number(h.tagName.charAt(1));
      stack = stack.slice(0, level - 1);
      stack[level - 1] = h.textContent.trim();
    }
    return stack.filter(Boolean).join(" > ");
  }

  function highlight(range, id, kind) {
    var root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentNode;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var parts = [];
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (!range.intersectsNode(n) || !n.textContent.trim() || n.parentElement.closest("svg")) continue;
      var start = n === range.startContainer ? range.startOffset : 0;
      var end = n === range.endContainer ? range.endOffset : n.textContent.length;
      if (start < end) parts.push([n, start, end]);
    }
    parts.forEach(function (p) {
      var target = p[0].splitText(p[1]);
      target.splitText(p[2] - p[1]);
      var mark = el("mark", "ann ann-" + kind);
      mark.dataset.id = id;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    });
  }

  // Non-whitespace characters of the document with their text positions. Selections and
  // textContent differ in whitespace (table cells, line breaks), so quotes are matched without it.
  function charMap() {
    var chars = [], text = "";
    var walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n.parentElement.closest("svg")) continue;
      for (var i = 0; i < n.textContent.length; i++) {
        var c = n.textContent.charAt(i);
        if (/\s/.test(c)) continue;
        chars.push([n, i]);
        text += c;
      }
    }
    return { chars: chars, text: text };
  }

  function anchorOf(range) {
    var chars = charMap().chars;
    for (var i = 0; i < chars.length; i++) {
      if (range.comparePoint(chars[i][0], chars[i][1]) >= 0) return i;
    }
    return 0;
  }

  function restoreHighlight(a) {
    var map = charMap();
    var needle = a.quote.replace(/\s+/g, "");
    var best = -1;
    for (var at = map.text.indexOf(needle); at >= 0 && needle; at = map.text.indexOf(needle, at + 1)) {
      if (best < 0 || Math.abs(at - (a.anchor || 0)) < Math.abs(best - (a.anchor || 0))) best = at;
    }
    if (best < 0) return;
    var first = map.chars[best], last = map.chars[best + needle.length - 1];
    var range = document.createRange();
    range.setStart(first[0], first[1]);
    range.setEnd(last[0], last[1] + 1);
    highlight(range, a.id, a.kind);
  }

  function unhighlight(id) {
    doc.querySelectorAll('mark[data-id="' + id + '"]').forEach(function (mark) {
      var parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function renderList() {
    var list = $("annotations");
    list.innerHTML = "";
    $("count").textContent = String(state.annotations.length);
    $("empty").hidden = state.annotations.length > 0;
    state.annotations.forEach(function (a, index) {
      var item = el("li", "annotation");
      item.dataset.id = a.id;
      var head = el("header");
      head.appendChild(el("span", "badge " + a.kind, KIND[a.kind]));
      head.appendChild(el("span", "section", a.section || ""));
      var remove = el("button", "remove", "×");
      remove.title = "删除这条批注";
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        unhighlight(a.id);
        state.annotations.splice(index, 1);
        saveDraft();
        renderList();
      });
      head.appendChild(remove);
      item.appendChild(head);
      item.appendChild(el("blockquote", "quote", a.quote.length > 240 ? a.quote.slice(0, 240) + "…" : a.quote));
      if (a.kind === "replace") item.appendChild(el("div", "text", "→ " + a.text));
      else if (a.text) item.appendChild(el("div", "text", a.text));
      item.addEventListener("click", function () {
        var mark = doc.querySelector('mark[data-id="' + a.id + '"]');
        if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      list.appendChild(item);
    });
  }

  function hideFloating() { toolbar.hidden = true; popover.hidden = true; popoverKind = null; }

  function checkSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { if (popover.hidden) toolbar.hidden = true; return; }
    var range = sel.getRangeAt(0);
    if (!doc.contains(range.commonAncestorContainer)) { toolbar.hidden = true; return; }
    var quote = sel.toString().trim();
    if (!quote) { toolbar.hidden = true; return; }
    pending = { range: range.cloneRange(), quote: quote, section: sectionOf(range.startContainer) };
    var rect = range.getBoundingClientRect();
    toolbar.style.top = (window.scrollY + rect.top - 46) + "px";
    toolbar.style.left = Math.max(110, window.scrollX + rect.left + rect.width / 2) + "px";
    toolbar.hidden = false;
    popover.hidden = true;
  }

  function addAnnotation(kind, text) {
    if (!pending) return;
    var a = { id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              kind: kind, quote: pending.quote, section: pending.section, text: text || "",
              anchor: anchorOf(pending.range) };
    highlight(pending.range, a.id, kind);
    state.annotations.push(a);
    pending = null;
    window.getSelection().removeAllRanges();
    hideFloating();
    saveDraft();
    renderList();
  }

  function openPopover(kind) {
    popoverKind = kind;
    $("popover-quote").textContent = (kind === "replace" ? "替换：" : "评论：") + pending.quote;
    var text = $("popover-text");
    text.value = kind === "replace" ? pending.quote : "";
    text.placeholder = kind === "replace" ? "改成…" : "写下你的意见…";
    popover.style.top = (parseFloat(toolbar.style.top) + 46) + "px";
    popover.style.left = Math.max(8, Math.min(parseFloat(toolbar.style.left) - 190, window.innerWidth - 400)) + "px";
    toolbar.hidden = true;
    popover.hidden = false;
    text.focus();
    text.select();
  }

  document.addEventListener("mouseup", function (event) {
    if (toolbar.contains(event.target) || popover.contains(event.target)) return;
    setTimeout(checkSelection, 0);
  });
  document.addEventListener("keyup", function (event) {
    if (event.key === "Escape") { hideFloating(); return; }
    if (event.shiftKey && !popover.contains(event.target)) checkSelection();
  });
  toolbar.addEventListener("mousedown", function (event) { event.preventDefault(); });
  toolbar.querySelectorAll("button").forEach(function (button) {
    button.addEventListener("click", function () {
      var kind = button.dataset.kind;
      if (kind === "delete") addAnnotation("delete", "");
      else openPopover(kind);
    });
  });
  $("popover-cancel").addEventListener("click", hideFloating);
  $("popover-save").addEventListener("click", function () {
    var text = $("popover-text").value.trim();
    if (!text) { toast(popoverKind === "replace" ? "请填写替换后的内容" : "请填写评论内容"); return; }
    addAnnotation(popoverKind, text);
  });
  $("popover-text").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("popover-save").click();
  });
  doc.addEventListener("click", function (event) {
    var mark = event.target.closest && event.target.closest("mark.ann");
    if (!mark) return;
    var item = document.querySelector('.annotation[data-id="' + mark.dataset.id + '"]');
    if (!item) return;
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    item.classList.add("flash");
    setTimeout(function () { item.classList.remove("flash"); }, 1200);
  });
  $("comment").addEventListener("input", function (event) { state.comment = event.target.value; saveDraft(); });

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
      $("pane-doc").hidden = tab.dataset.tab !== "doc";
      $("pane-diff").hidden = tab.dataset.tab !== "diff";
      hideFloating();
    });
  });

  function renderDiff() {
    if (!data.diff) return;
    var added = 0, removed = 0;
    data.diff.forEach(function (l) { if (l.kind === "add") added++; if (l.kind === "del") removed++; });
    $("diff-stats").textContent = "+" + added + " −" + removed;
    var box = $("diff");
    var CONTEXT = 3;
    var i = 0;
    while (i < data.diff.length) {
      if (data.diff[i].kind !== "same") { appendLine(box, data.diff[i]); i++; continue; }
      var j = i;
      while (j < data.diff.length && data.diff[j].kind === "same") j++;
      var run = j - i;
      var head = i === 0 ? 0 : CONTEXT;
      var tail = j === data.diff.length ? 0 : CONTEXT;
      if (run > head + tail + 2) {
        for (var k = i; k < i + head; k++) appendLine(box, data.diff[k]);
        box.appendChild(el("div", "gap", "… " + (run - head - tail) + " 行未变 …"));
        for (k = j - tail; k < j; k++) appendLine(box, data.diff[k]);
      } else {
        for (k = i; k < j; k++) appendLine(box, data.diff[k]);
      }
      i = j;
    }
    if (!added && !removed) box.appendChild(el("div", "gap", "与上一版相同"));
  }

  function appendLine(box, line) {
    var sign = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
    box.appendChild(el("div", line.kind === "same" ? "" : line.kind, sign + line.text));
  }

  function renderPrevious() {
    var p = data.previous;
    if (!p) return;
    var box = el("details", "previous");
    box.open = true;
    box.appendChild(el("summary", null, "上一版（第 " + p.revision + " 版）意见：" + (DECISION[p.decision] || p.decision)));
    if (p.comment) box.appendChild(el("p", null, p.comment));
    var list = el("ol");
    p.annotations.forEach(function (a) {
      var text = "[" + KIND[a.kind] + "] “" + a.quote.slice(0, 120) + "”" + (a.text ? (a.kind === "replace" ? " → " : "：") + a.text : "");
      list.appendChild(el("li", null, text));
    });
    if (p.annotations.length) box.appendChild(list);
    $("previous").appendChild(box);
  }

  document.querySelectorAll("[data-decision]").forEach(function (button) {
    button.addEventListener("click", function () {
      var decision = button.dataset.decision;
      var hasNotes = state.annotations.length > 0 || state.comment.trim().length > 0;
      if (decision !== "approved" && !hasNotes) { toast("请先添加批注或填写总体意见"); return; }
      if (decision === "approved" && hasNotes) decision = "approved_with_notes";
      submit(decision);
    });
  });

  function submit(decision) {
    var body = {
      decision: decision,
      comment: state.comment.trim(),
      annotations: state.annotations.map(function (a) { return { kind: a.kind, quote: a.quote, section: a.section, text: a.text }; })
    };
    fetch("/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json", "x-review-token": data.token },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      try { localStorage.removeItem(draftKey); } catch (e) {}
      $("done-title").textContent = "已提交：" + DECISION[decision];
      $("done").hidden = false;
    }).catch(function (error) {
      toast("提交失败（" + error.message + "）。Agent 可能已停止等待，请回到对话窗口查看。");
    });
  }

  state.annotations.forEach(restoreHighlight);
  renderList();
  renderDiff();
  renderPrevious();
})();
`;

// src/review/store.ts
import { mkdir as mkdir2, readdir as readdir2, readFile as readFile3, rm, writeFile as writeFile3 } from "node:fs/promises";
import path4 from "node:path";

// src/review/diff.ts
function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i2 = a.length - 1; i2 >= 0; i2--) {
    for (let j2 = b.length - 1; j2 >= 0; j2--) {
      lcs[i2][j2] = a[i2] === b[j2] ? lcs[i2 + 1][j2 + 1] + 1 : Math.max(lcs[i2 + 1][j2], lcs[i2][j2 + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

// src/review/store.ts
var DECISIONS = ["approved", "approved_with_notes", "changes_requested"];
var ANNOTATION_KINDS = /* @__PURE__ */ new Set(["comment", "delete", "replace"]);
var IMAGE_TYPES = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
function resolveProjectFile(rootDir, targetFile) {
  const root = path4.resolve(rootDir);
  const full = path4.resolve(root, targetFile);
  if (!isPathInside(root, full)) {
    throw new Error(`${targetFile} is outside ${root}`);
  }
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normFull = process.platform === "win32" ? full.toLowerCase() : full;
  const relNorm = path4.relative(normRoot, normFull);
  const relActual = full.slice(full.length - relNorm.length);
  return { root, full, relFile: relActual.split(path4.sep).join("/") };
}
function historyDirFor(root, fileFullPath) {
  const { relFile } = resolveProjectFile(root, fileFullPath);
  const withoutExt = relFile.replace(/\.[^./]+$/, "");
  const cleanArchMatch = withoutExt.match(/^\.clean-arch\/([^/]+)$/);
  const slug = cleanArchMatch ? cleanArchMatch[1] : withoutExt.replace(/^\.clean-arch\//, "").replace(/\//g, "__").replace(/[^A-Za-z0-9_.\-\u4e00-\u9fa5]/g, "_");
  return path4.join(path4.resolve(root), ".clean-arch", "reviews", slug || "doc");
}
async function enterReviewState(root, relFile) {
  const existingState = await readWorkflowState(root);
  if (existingState || relFile === ".clean-arch/plan.md" || relFile === ".clean-arch/perf.md") {
    await writeWorkflowState(root, "awaiting_approval", relFile);
  }
}
function firstHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? "";
}
async function readHistory(dir) {
  const entries = /* @__PURE__ */ new Map();
  let names;
  try {
    names = await readdir2(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const match = name.match(/^r(\d+)\.(md|json)$/);
    if (!match) continue;
    const revision = Number(match[1]);
    const entry = entries.get(revision) ?? { revision };
    const text = await readFile3(path4.join(dir, name), "utf8");
    if (match[2] === "md") entry.markdown = text;
    else {
      try {
        const feedback = JSON.parse(text);
        if (DECISIONS.includes(feedback.decision)) entry.feedback = feedback;
      } catch {
      }
    }
    entries.set(revision, entry);
  }
  return [...entries.values()].sort((a, b) => a.revision - b.revision);
}
function normalizeAnnotations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a) => a && ANNOTATION_KINDS.has(a.kind) && typeof a.quote === "string").map((a) => ({
    kind: a.kind,
    quote: a.quote,
    section: String(a.section ?? ""),
    text: String(a.text ?? "")
  }));
}
function parseDecision(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!DECISIONS.includes(body?.decision)) return null;
  return {
    decision: body.decision,
    comment: String(body.comment ?? ""),
    annotations: normalizeAnnotations(body.annotations)
  };
}
async function prepareReviewDocument(options) {
  const { root, full, relFile } = resolveProjectFile(options.root, options.file);
  const markdown = await readFile3(full, "utf8");
  const historyDir = historyDirFor(root, full);
  await mkdir2(historyDir, { recursive: true });
  const last = (await readHistory(historyDir)).filter((entry) => entry.feedback).at(-1);
  const revision = (last?.revision ?? 0) + 1;
  await writeFile3(path4.join(historyDir, `r${revision}.md`), markdown, "utf8");
  const token = options.token ?? "";
  const diagramWarnings2 = [];
  const docDir = path4.posix.dirname(relFile);
  const html = renderMarkdown(markdown, docDir, token, diagramWarnings2, {
    imageMode: options.imageMode ?? "http",
    rootDir: root
  });
  const draft = await loadReviewDraft(historyDir, revision);
  const page = {
    title: options.title || firstHeading(markdown) || path4.basename(full),
    file: relFile,
    revision,
    token,
    html,
    diff: last?.markdown !== void 0 ? diffLines(last.markdown, markdown) : null,
    previous: last?.feedback ? {
      revision: last.revision,
      decision: last.feedback.decision,
      comment: last.feedback.comment,
      annotations: last.feedback.annotations
    } : null
  };
  return { root, relFile, historyDir, page, diagramWarnings: diagramWarnings2, draft };
}
async function loadReviewDraft(historyDir, revision) {
  try {
    const raw = await readFile3(path4.join(historyDir, `draft-r${revision}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const annotations = Array.isArray(parsed.annotations) ? parsed.annotations.filter((a) => a && ANNOTATION_KINDS.has(a.kind) && typeof a.quote === "string").map((a) => ({
      id: typeof a.id === "string" ? a.id : void 0,
      anchor: typeof a.anchor === "number" ? a.anchor : void 0,
      kind: a.kind,
      quote: a.quote,
      section: String(a.section ?? ""),
      text: String(a.text ?? "")
    })) : [];
    return { comment: String(parsed.comment ?? ""), annotations };
  } catch {
    return null;
  }
}
async function commitReviewDecision(options) {
  const { root, full, relFile } = resolveProjectFile(options.root, options.file);
  if (options.decision === "timeout" || options.decision === "cancelled") {
    return {
      decision: options.decision,
      comment: "",
      annotations: [],
      revision: options.revision,
      record: "",
      url: options.url,
      diagramWarnings: options.diagramWarnings
    };
  }
  const historyDir = historyDirFor(root, full);
  await mkdir2(historyDir, { recursive: true });
  const recordPath = path4.join(historyDir, `r${options.revision}.json`);
  const payload = {
    decision: options.decision,
    comment: options.comment,
    annotations: options.annotations,
    revision: options.revision,
    file: relFile,
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeFile3(recordPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await rm(path4.join(historyDir, `draft-r${options.revision}.json`), { force: true });
  const existingState = await readWorkflowState(root);
  const isTrackedPlan = relFile === ".clean-arch/plan.md" || relFile === ".clean-arch/perf.md";
  if (existingState || isTrackedPlan) {
    if (options.decision === "approved" || options.decision === "approved_with_notes") {
      await writeWorkflowState(root, "executing", relFile);
    } else if (options.decision === "changes_requested") {
      await writeWorkflowState(root, "awaiting_approval", relFile);
    }
  }
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normRec = process.platform === "win32" ? recordPath.toLowerCase() : recordPath;
  const relLen = path4.relative(normRoot, normRec).length;
  const recordRel = recordPath.slice(recordPath.length - relLen).split(path4.sep).join("/");
  return {
    decision: options.decision,
    comment: options.comment,
    annotations: options.annotations,
    revision: options.revision,
    record: recordRel,
    url: options.url,
    diagramWarnings: options.diagramWarnings
  };
}
async function readSafeProjectImage(rootDir, relPath) {
  const root = path4.resolve(rootDir);
  const full = path4.resolve(root, relPath);
  const type = IMAGE_TYPES[path4.extname(full).toLowerCase()];
  if (!type || !isPathInside(root, full)) return null;
  try {
    const body = await readFile3(full);
    return { type, body };
  } catch {
    return null;
  }
}
function formatOutcome(outcome) {
  if (outcome.decision === "timeout" || outcome.decision === "cancelled") {
    return [
      `Decision: ${outcome.decision}`,
      `Revision: ${outcome.revision} (undecided; any saved draft was preserved)`,
      "",
      "No decision was made in the review page. Ask the user in chat to review the file and approve or give feedback."
    ].join("\n");
  }
  const lines = [`Decision: ${outcome.decision}`, `Revision: ${outcome.revision} (feedback saved to ${outcome.record})`];
  if (outcome.comment) lines.push("", "General comment:", outcome.comment);
  if (outcome.diagramWarnings?.length) {
    lines.push("", "Diagram rendering warnings (fix them in this document):", ...outcome.diagramWarnings.map((w) => `- ${w}`));
  }
  if (outcome.annotations.length) {
    lines.push("", `Annotations (${outcome.annotations.length}):`);
    outcome.annotations.forEach((a, i) => {
      const where = a.section ? ` in "${a.section}"` : "";
      const quote = JSON.stringify(a.quote);
      if (a.kind === "replace") lines.push(`${i + 1}. [replace]${where}: ${quote} -> ${JSON.stringify(a.text)}`);
      else if (a.kind === "delete") lines.push(`${i + 1}. [delete]${where}: ${quote}`);
      else lines.push(`${i + 1}. [comment]${where}: ${quote}`, `   ${a.text}`);
    });
  }
  lines.push(
    "",
    outcome.decision === "changes_requested" ? "Next: apply every annotation (edit only what the feedback touches), then call clean_arch_review again." : outcome.decision === "approved_with_notes" ? "Next: apply the notes that do not change scope, then continue with the approved plan." : "Next: the document is approved; continue."
  );
  return lines.join("\n");
}

// src/review/server.ts
function reviewSettingsFromEnv(env = process.env) {
  const minutes = Number(env.CLEAN_ARCH_REVIEW_TIMEOUT_MIN ?? 120);
  return {
    host: env.CLEAN_ARCH_REVIEW_HOST || "127.0.0.1",
    port: Number(env.CLEAN_ARCH_REVIEW_PORT ?? 0) || 0,
    timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 6e4,
    openBrowser: !["1", "true", "yes"].includes((env.CLEAN_ARCH_REVIEW_NO_OPEN ?? "").toLowerCase()),
    publicHost: env.CLEAN_ARCH_REVIEW_PUBLIC_HOST || ""
  };
}
async function runReview(options) {
  const session = await startReview(options);
  const onAbort = () => session.cancel();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    return await session.outcome;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
async function startReview(options) {
  const settings = reviewSettingsFromEnv();
  const host = options.host ?? settings.host;
  const token = randomBytes(12).toString("hex");
  const prepared = await prepareReviewDocument({
    root: options.root,
    file: options.file,
    title: options.title,
    token,
    imageMode: "http"
  });
  await enterReviewState(prepared.root, prepared.relFile);
  const html = renderPage(prepared.page);
  let settle;
  const decided = new Promise(
    (resolve) => settle = resolve
  );
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, "text/plain", String(error)));
  });
  async function handle(req, res) {
    const url2 = new URL(req.url ?? "/", "http://localhost");
    const authorized = url2.searchParams.get("t") === token || req.headers["x-review-token"] === token;
    if (!authorized) return send(res, 403, "text/plain", "Missing or wrong review token. Open the link printed by the agent.");
    if (req.method === "GET" && url2.pathname === "/") return send(res, 200, "text/html; charset=utf-8", html);
    if (req.method === "GET" && url2.pathname.startsWith("/file/")) {
      const img = await readSafeProjectImage(prepared.root, decodeURIComponent(url2.pathname.slice(6)));
      if (!img) return send(res, 404, "text/plain", "not found");
      res.writeHead(200, { "content-type": img.type, "cache-control": "no-store", "content-security-policy": "script-src 'none'" });
      res.end(img.body);
      return;
    }
    if (req.method === "POST" && url2.pathname === "/api/decision") {
      const body = parseDecision(await readBody(req));
      if (!body) return send(res, 400, "text/plain", "invalid decision");
      send(res, 200, "application/json", '{"ok":true}');
      settle(body);
      return;
    }
    send(res, 404, "text/plain", "not found");
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? settings.port, host, () => resolve());
  });
  const { port } = server.address();
  const shownHost = settings.publicHost || (host === "0.0.0.0" || host === "::" ? os.hostname() : host);
  const url = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}/?t=${token}`;
  options.onReady?.(url);
  if (options.openBrowser ?? settings.openBrowser) openInBrowser(url);
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  const timer = setTimeout(() => settle({ decision: "timeout", comment: "", annotations: [] }), timeoutMs);
  timer.unref?.();
  const outcome = decided.then(async (result) => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
    return commitReviewDecision({
      root: prepared.root,
      file: prepared.relFile,
      revision: prepared.page.revision,
      decision: result.decision,
      comment: result.comment,
      annotations: result.annotations,
      diagramWarnings: prepared.diagramWarnings,
      url
    });
  });
  return { url, revision: prepared.page.revision, outcome, cancel: () => settle({ decision: "cancelled", comment: "", annotations: [] }) };
}
function send(res, status, type, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2e6) req.destroy(new Error("body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function openInBrowser(url) {
  const platform = process.platform;
  const hasDisplay = platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) return;
  const [cmd, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}

// <stdin>
var USAGE = `usage:
  bun src/cli.ts render [path] [--force]   render *.mmd to *.svg (default docs/architecture/diagrams)
  bun src/cli.ts review <file.md> [--title T]   open the review page and print the decision`;
async function main(argv) {
  const [command, ...rest] = argv;
  const force = rest.includes("--force");
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--title");
  if (command === "render") {
    const result = await renderDiagrams(path5.resolve(positional[0] ?? "docs/architecture/diagrams"), force);
    for (const file of result.rendered) console.log(`+ ${path5.relative(process.cwd(), file)}`);
    for (const { file, error } of result.failed) console.error(`! ${path5.relative(process.cwd(), file)}: ${error}`);
    for (const { file, message } of result.warnings) console.error(`? ${path5.relative(process.cwd(), file)}: ${message}`);
    console.log(`rendered ${result.rendered.length}, up to date ${result.skipped.length}, failed ${result.failed.length}`);
    return result.failed.length ? 1 : 0;
  }
  if (command === "review" && positional[0]) {
    const titleIndex = rest.indexOf("--title");
    const outcome = await runReview({
      root: process.cwd(),
      file: positional[0],
      title: titleIndex >= 0 ? rest[titleIndex + 1] : void 0,
      onReady: (url) => console.error(`review page: ${url}`)
    });
    console.log(formatOutcome(outcome));
    return outcome.decision === "approved" || outcome.decision === "approved_with_notes" ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}
process.exit(await main(process.argv.slice(2)));
