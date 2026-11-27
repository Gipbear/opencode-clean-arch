import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps"

type AnnotationKind = "comment" | "delete" | "replace"
type Decision = "approved" | "approved_with_notes" | "changes_requested"

interface DraftAnnotation {
  id: string
  kind: AnnotationKind
  quote: string
  section: string
  text: string
  anchor: number
}

interface DiffLine {
  kind: "same" | "add" | "del"
  text: string
}

interface ReviewPayload {
  mode: "review" | "empty"
  root: string
  file: string
  title?: string
  revision?: number
  html?: string
  diff?: DiffLine[] | null
  previous?: { revision: number; decision: Decision; comment: string; annotations: Omit<DraftAnnotation, "id" | "anchor">[] } | null
  draft?: { comment: string; annotations: Partial<DraftAnnotation>[] } | null
  uiToken?: string
  message?: string
}

const KIND_LABEL: Record<AnnotationKind, string> = { comment: "评论", delete: "删除", replace: "替换" }
const DECISION_LABEL: Record<Decision, string> = {
  approved: "批准",
  approved_with_notes: "批准并附意见",
  changes_requested: "要求修改",
}

const app = new App({ name: "clean-arch-review", version: "0.4.2" }, {})

let currentRoot = ""
let currentFile = ""
let currentRevision = 1
let currentUiToken = ""
let state: { annotations: DraftAnnotation[]; comment: string } = { annotations: [], comment: "" }
let pending: { range: Range; quote: string; section: string } | null = null
let popoverKind: "comment" | "replace" | null = null
let draftTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let submitting = false

const $ = (id: string) => document.getElementById(id)!
const doc = $("doc")
const toolbar = $("toolbar")
const popover = $("popover")

function toast(message: string) {
  const t = $("toast")
  t.textContent = message
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    t.hidden = true
  }, 2800)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** 将服务端已净化过的 HTML 片段安全注入容器，避免使用 innerHTML。 */
function setSafeDocumentHtml(container: HTMLElement, html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  container.replaceChildren(...Array.from(parsed.body.childNodes))
}

function persistDraft(immediate = false) {
  if (!currentRoot || !currentFile) return
  const flush = () => {
    void app
      .callServerTool({
        name: "review_app_save_draft",
        arguments: {
          root: currentRoot,
          file: currentFile,
          revision: currentRevision,
          draft: state,
        },
      })
      .catch(() => {})
  }
  clearTimeout(draftTimer)
  if (immediate) flush()
  else draftTimer = setTimeout(flush, 250)
}

function sectionOf(node: Node): string {
  const target = node.nodeType === 1 ? (node as Element) : node.parentElement
  if (!target) return ""
  let stack: string[] = []
  const heads = doc.querySelectorAll("h1, h2, h3, h4")
  for (const h of Array.from(heads)) {
    const before = h.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
    if (!before && !h.contains(target)) break
    const level = Number(h.tagName.charAt(1))
    stack = stack.slice(0, level - 1)
    stack[level - 1] = (h.textContent || "").trim()
  }
  return stack.filter(Boolean).join(" > ")
}

function highlightRange(range: Range, id: string, kind: AnnotationKind) {
  let rootNode: Node = range.commonAncestorContainer
  if (rootNode.nodeType === 3 && rootNode.parentNode) rootNode = rootNode.parentNode
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT)
  const parts: Array<[Text, number, number]> = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (!range.intersectsNode(n) || !(n.textContent || "").trim() || n.parentElement?.closest("svg")) continue
    const start = n === range.startContainer ? range.startOffset : 0
    const end = n === range.endContainer ? range.endOffset : (n.textContent || "").length
    if (start < end) parts.push([n, start, end])
  }
  for (const [textNode, start, end] of parts) {
    const target = textNode.splitText(start)
    target.splitText(end - start)
    const mark = el("mark", `ann ann-${kind}`)
    mark.dataset.id = id
    target.parentNode?.insertBefore(mark, target)
    mark.appendChild(target)
  }
}

function charMap() {
  const chars: Array<[Text, number]> = []
  let text = ""
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (n.parentElement?.closest("svg")) continue
    const content = n.textContent || ""
    for (let i = 0; i < content.length; i++) {
      const c = content.charAt(i)
      if (/\s/.test(c)) continue
      chars.push([n, i])
      text += c
    }
  }
  return { chars, text }
}

function anchorOf(range: Range): number {
  const { chars } = charMap()
  for (let i = 0; i < chars.length; i++) {
    if (range.comparePoint(chars[i][0], chars[i][1]) >= 0) return i
  }
  return 0
}

function restoreHighlight(a: DraftAnnotation) {
  const map = charMap()
  const needle = a.quote.replace(/\s+/g, "")
  if (!needle) return
  let best = -1
  for (let at = map.text.indexOf(needle); at >= 0; at = map.text.indexOf(needle, at + 1)) {
    if (best < 0 || Math.abs(at - (a.anchor || 0)) < Math.abs(best - (a.anchor || 0))) best = at
  }
  if (best < 0) return
  const first = map.chars[best]
  const last = map.chars[best + needle.length - 1]
  const range = document.createRange()
  range.setStart(first[0], first[1])
  range.setEnd(last[0], last[1] + 1)
  highlightRange(range, a.id, a.kind)
}

function escAttr(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&")
}

function activateTab(name: "doc" | "diff") {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name))
  $("pane-doc").hidden = name !== "doc"
  $("pane-diff").hidden = name !== "diff"
  hideFloating()
}

function unhighlight(id: string) {
  doc.querySelectorAll(`mark[data-id="${escAttr(id)}"]`).forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

function renderList() {
  const list = $("annotations")
  list.replaceChildren()
  $("count").textContent = String(state.annotations.length)
  $("empty").hidden = state.annotations.length > 0
  state.annotations.forEach((a, index) => {
    const item = el("li", "annotation")
    item.dataset.id = a.id
    const head = el("header")
    head.appendChild(el("span", `badge ${a.kind}`, KIND_LABEL[a.kind]))
    head.appendChild(el("span", "section", a.section || ""))
    const remove = el("button", "remove", "×")
    remove.title = "删除这条批注"
    remove.addEventListener("click", (event) => {
      event.stopPropagation()
      unhighlight(a.id)
      state.annotations.splice(index, 1)
      persistDraft(true)
      renderList()
    })
    head.appendChild(remove)
    item.appendChild(head)
    item.appendChild(el("blockquote", "quote", a.quote.length > 240 ? `${a.quote.slice(0, 240)}…` : a.quote))
    if (a.kind === "replace") item.appendChild(el("div", "text", `→ ${a.text}`))
    else if (a.text) item.appendChild(el("div", "text", a.text))
    item.addEventListener("click", () => {
      const mark = doc.querySelector(`mark[data-id="${escAttr(a.id)}"]`)
      if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" })
    })
    list.appendChild(item)
  })
}

function hideFloating() {
  toolbar.hidden = true
  popover.hidden = true
  popoverKind = null
}

function checkSelection() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    if (popover.hidden) toolbar.hidden = true
    return
  }
  const range = sel.getRangeAt(0)
  if (!doc.contains(range.commonAncestorContainer)) {
    toolbar.hidden = true
    return
  }
  const quote = sel.toString().trim()
  if (!quote) {
    toolbar.hidden = true
    return
  }
  pending = { range: range.cloneRange(), quote, section: sectionOf(range.startContainer) }
  const rect = range.getBoundingClientRect()
  toolbar.style.top = `${window.scrollY + rect.top - 42}px`
  toolbar.style.left = `${Math.max(100, window.scrollX + rect.left + rect.width / 2)}px`
  toolbar.hidden = false
  popover.hidden = true
}

function addAnnotation(kind: AnnotationKind, text: string) {
  if (!pending) return
  const a: DraftAnnotation = {
    id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind,
    quote: pending.quote,
    section: pending.section,
    text: text || "",
    anchor: anchorOf(pending.range),
  }
  highlightRange(pending.range, a.id, kind)
  state.annotations.push(a)
  pending = null
  window.getSelection()?.removeAllRanges()
  hideFloating()
  persistDraft(true)
  renderList()
}

function openPopover(kind: "comment" | "replace") {
  if (!pending) return
  popoverKind = kind
  $("popover-quote").textContent = `${kind === "replace" ? "替换：" : "评论："}${pending.quote}`
  const text = $("popover-text") as HTMLTextAreaElement
  text.value = kind === "replace" ? pending.quote : ""
  text.placeholder = kind === "replace" ? "改成…" : "写下你的意见…"
  popover.style.top = `${parseFloat(toolbar.style.top) + 42}px`
  popover.style.left = `${Math.max(8, Math.min(parseFloat(toolbar.style.left) - 170, window.innerWidth - 360))}px`
  toolbar.hidden = true
  popover.hidden = false
  text.focus()
  text.select()
}

function renderDiff(diff: DiffLine[] | null | undefined) {
  const box = $("diff")
  box.replaceChildren()
  if (!diff) {
    $("tab-diff").hidden = true
    activateTab("doc")
    return
  }
  $("tab-diff").hidden = false
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.kind === "add") added++
    if (l.kind === "del") removed++
  }
  $("diff-stats").textContent = `+${added} −${removed}`
  const CONTEXT = 3
  let i = 0
  while (i < diff.length) {
    if (diff[i].kind !== "same") {
      appendDiffLine(box, diff[i])
      i++
      continue
    }
    let j = i
    while (j < diff.length && diff[j].kind === "same") j++
    const run = j - i
    const head = i === 0 ? 0 : CONTEXT
    const tail = j === diff.length ? 0 : CONTEXT
    if (run > head + tail + 2) {
      for (let k = i; k < i + head; k++) appendDiffLine(box, diff[k])
      box.appendChild(el("div", "gap", `… ${run - head - tail} 行未变 …`))
      for (let k = j - tail; k < j; k++) appendDiffLine(box, diff[k])
    } else {
      for (let k = i; k < j; k++) appendDiffLine(box, diff[k])
    }
    i = j
  }
  if (!added && !removed) box.appendChild(el("div", "gap", "与上一版相同"))
}

function appendDiffLine(box: HTMLElement, line: DiffLine) {
  const sign = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "
  box.appendChild(el("div", line.kind === "same" ? "" : line.kind, sign + line.text))
}

function renderPrevious(previous: ReviewPayload["previous"]) {
  const container = $("previous")
  container.replaceChildren()
  if (!previous) return
  const box = el("details", "previous")
  box.open = true
  box.appendChild(el("summary", undefined, `上一版（第 ${previous.revision} 版）意见：${DECISION_LABEL[previous.decision] || previous.decision}`))
  if (previous.comment) box.appendChild(el("p", undefined, previous.comment))
  if (previous.annotations.length) {
    const list = el("ol")
    for (const a of previous.annotations) {
      const suffix = a.text ? `${a.kind === "replace" ? " → " : "："}${a.text}` : ""
      list.appendChild(el("li", undefined, `[${KIND_LABEL[a.kind]}] “${a.quote.slice(0, 120)}”${suffix}`))
    }
    box.appendChild(list)
  }
  container.appendChild(box)
}

function renderPayload(payload: ReviewPayload) {
  if (!payload || payload.mode === "empty" || !payload.html) {
    $("topbar").hidden = true
    $("main-layout").hidden = true
    $("empty-view").hidden = false
    $("empty-title").textContent = payload?.file ? `未找到待评审文档：${payload.file}` : "暂无待评审文档"
    $("empty-desc").textContent = payload?.message || "请在对话中使用 /clean-arch、/arch-plan 或 /arch-review 打开需要评审的 Markdown 文档。"
    return
  }

  currentRoot = payload.root
  currentFile = payload.file
  currentRevision = payload.revision ?? 1
  if (payload.uiToken) currentUiToken = payload.uiToken
  $("empty-view").hidden = true
  $("done-banner").hidden = true
  $("topbar").hidden = false
  $("main-layout").hidden = false
  activateTab("doc")

  $("doc-title").textContent = payload.title || payload.file
  $("doc-meta").textContent = `${payload.file} · 第 ${currentRevision} 版`
  setSafeDocumentHtml(doc, payload.html)

  const draftAnnotations: DraftAnnotation[] = Array.isArray(payload.draft?.annotations)
    ? payload.draft!.annotations
        .filter((a): a is DraftAnnotation => Boolean(a && a.kind && a.quote))
        .map((a, idx) => ({
          id: a.id || `d${idx}_${Date.now().toString(36)}`,
          kind: a.kind,
          quote: a.quote,
          section: a.section || "",
          text: a.text || "",
          anchor: typeof a.anchor === "number" ? a.anchor : 0,
        }))
    : []
  state = {
    comment: payload.draft?.comment ?? "",
    annotations: draftAnnotations,
  }
  ;($("comment") as HTMLTextAreaElement).value = state.comment
  for (const a of state.annotations) restoreHighlight(a)
  renderList()
  renderDiff(payload.diff)
  renderPrevious(payload.previous)
}

async function loadFromServer(root: string, file: string, title?: string) {
  try {
    const res = await app.callServerTool({
      name: "review_app_load",
      arguments: { root, file, ...(title ? { title } : {}) },
    })
    const payload = res.structuredContent as unknown as ReviewPayload | undefined
    if (payload) renderPayload(payload)
  } catch (error) {
    toast(`加载评审文档失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function submitDecision(decision: Decision) {
  if (submitting || !currentRoot || !currentFile) return
  submitting = true
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-decision]")
  buttons.forEach((b) => (b.disabled = true))
  try {
    const res = await app.callServerTool({
      name: "review_app_submit",
      arguments: {
        root: currentRoot,
        file: currentFile,
        revision: currentRevision,
        decision,
        comment: state.comment.trim(),
        annotations: state.annotations.map((a) => ({
          kind: a.kind,
          quote: a.quote,
          section: a.section,
          text: a.text,
        })),
        uiToken: currentUiToken,
      },
    })
    const result = res.structuredContent as { formatted?: string; record?: string } | undefined
    const formatted = result?.formatted || `Decision: ${decision}`
    const banner = $("done-banner")
    banner.hidden = false

    const caps = app.getHostCapabilities()
    if (caps?.message) {
      await app.sendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: `我已在架构评审面板提交评审结论（${DECISION_LABEL[decision]}）：\n\n${formatted}`,
          },
        ],
      })
      banner.textContent = `已提交结论（${DECISION_LABEL[decision]}），并已自动通知当前对话中的 Agent。`
    } else if (caps?.updateModelContext) {
      await app.updateModelContext({
        content: [{ type: "text", text: `架构评审结论（${currentFile}）：\n${formatted}` }],
      })
      banner.textContent = `已保存结论（${DECISION_LABEL[decision]}）至 ${result?.record ?? ".clean-arch/reviews/"}，并已附加到下次对话上下文。`
    } else {
      banner.textContent = `已保存结论（${DECISION_LABEL[decision]}）至 ${result?.record ?? ".clean-arch/reviews/"}。请回到对话窗口告知 Agent 继续。`
    }
    toast(`已提交：${DECISION_LABEL[decision]}`)
  } catch (error) {
    toast(`提交失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    submitting = false
    buttons.forEach((b) => (b.disabled = false))
  }
}

// 绑定文档选区与交互事件
document.addEventListener("mouseup", (event) => {
  const target = event.target as Node | null
  if (target && (toolbar.contains(target) || popover.contains(target))) return
  setTimeout(checkSelection, 0)
})
document.addEventListener("keyup", (event) => {
  if (event.key === "Escape") {
    hideFloating()
    return
  }
  const target = event.target as Node | null
  if (event.shiftKey && target && !popover.contains(target)) checkSelection()
})
toolbar.addEventListener("mousedown", (event) => event.preventDefault())
toolbar.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
  button.addEventListener("click", () => {
    const kind = button.dataset.kind as AnnotationKind | undefined
    if (!kind) return
    if (kind === "delete") addAnnotation("delete", "")
    else openPopover(kind)
  })
})
$("popover-cancel").addEventListener("click", hideFloating)
$("popover-save").addEventListener("click", () => {
  if (!popoverKind) return
  const input = $("popover-text") as HTMLTextAreaElement
  const text = input.value.trim()
  if (!text) {
    toast(popoverKind === "replace" ? "请填写替换后的内容" : "请填写评论内容")
    return
  }
  addAnnotation(popoverKind, text)
})
$("popover-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) $("popover-save").click()
})
doc.addEventListener("click", (event) => {
  const mark = (event.target as HTMLElement | null)?.closest("mark.ann") as HTMLElement | null
  if (!mark?.dataset.id) return
  const item = document.querySelector(`.annotation[data-id="${escAttr(mark.dataset.id)}"]`)
  if (!item) return
  item.scrollIntoView({ behavior: "smooth", block: "nearest" })
  item.classList.add("flash")
  setTimeout(() => item.classList.remove("flash"), 1200)
})
$("comment").addEventListener("input", (event) => {
  state.comment = (event.target as HTMLTextAreaElement).value
  persistDraft(false)
})

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab === "diff" ? "diff" : "doc")
  })
})

document.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => {
  button.addEventListener("click", () => {
    let decision = button.dataset.decision as Decision
    const hasNotes = state.annotations.length > 0 || state.comment.trim().length > 0
    if (decision !== "approved" && !hasNotes) {
      toast("请先添加批注或填写总体意见")
      return
    }
    if (decision === "approved" && hasNotes) decision = "approved_with_notes"
    void submitDecision(decision)
  })
})

// 按 MCP Apps 规范：在 connect() 之前注册所有事件处理器
app.ontoolinput = () => {
  $("empty-title").textContent = "正在准备评审文档…"
}
app.ontoolresult = (result) => {
  const sc = result.structuredContent as unknown as ReviewPayload | undefined
  if (!sc) return
  if (sc.mode === "review" && !sc.html && sc.root && sc.file) {
    void loadFromServer(sc.root, sc.file, sc.title)
  } else {
    renderPayload(sc)
  }
}
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme)
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
}

void app.connect().then(() => {
  const ctx = app.getHostContext()
  if (ctx?.theme) applyDocumentTheme(ctx.theme)
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
})
