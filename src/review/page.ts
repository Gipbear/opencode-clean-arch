import type { DiffLine } from "./diff.ts"
import { escapeHtml } from "./markdown.ts"
import type { Annotation, Decision } from "./types.ts"

export interface PageData {
  title: string
  file: string
  revision: number
  token: string
  html: string
  diff: DiffLine[] | null
  previous: { revision: number; decision: Decision; comment: string; annotations: Annotation[] } | null
}

export function renderPage(data: PageData): string {
  const { html, ...clientData } = data
  const json = JSON.stringify(clientData).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)} · 方案评审</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="title">
    <h1>${escapeHtml(data.title)}</h1>
    <div class="meta"><code>${escapeHtml(data.file)}</code> · 第 ${data.revision} 版</div>
  </div>
  <nav class="tabs">
    <button class="tab active" data-tab="doc">文档</button>
    <button class="tab" data-tab="diff" ${data.diff ? "" : "hidden"}>与上一版差异 <span id="diff-stats"></span></button>
  </nav>
  <div class="actions">
    <button class="btn danger" data-decision="changes_requested">要求修改</button>
    <button class="btn" data-decision="approved_with_notes">批准并附意见</button>
    <button class="btn primary" data-decision="approved">批准</button>
  </div>
</header>
<main class="layout">
  <section class="pane" id="pane-doc">
    <p class="hint">选中文字可以添加<b>评论</b>、<b>删除</b>或<b>替换</b>建议；右侧填写总体意见后选择评审结论。</p>
    <article id="doc" class="markdown">${html}</article>
  </section>
  <section class="pane" id="pane-diff" hidden>
    <div id="diff" class="diff"></div>
  </section>
  <aside class="sidebar">
    <h2>批注 <span id="count" class="count">0</span></h2>
    <p id="empty" class="empty">还没有批注。在文档中选中文字开始。</p>
    <ol id="annotations" class="annotations"></ol>
    <label class="general">
      <span>总体意见</span>
      <textarea id="comment" rows="5" placeholder="对整份方案的意见（可选）"></textarea>
    </label>
    <div id="previous"></div>
  </aside>
</main>
<div id="toolbar" class="toolbar" hidden>
  <button data-kind="comment">评论</button>
  <button data-kind="delete">删除</button>
  <button data-kind="replace">替换</button>
</div>
<div id="popover" class="popover" hidden>
  <div class="popover-quote" id="popover-quote"></div>
  <textarea id="popover-text" rows="4"></textarea>
  <div class="popover-actions">
    <button class="btn" id="popover-cancel">取消</button>
    <button class="btn primary" id="popover-save">添加</button>
  </div>
</div>
<div id="done" class="done" hidden>
  <div class="done-card">
    <h2 id="done-title">已提交</h2>
    <p>评审结果已发送给 Agent，可以关闭此页面回到 opencode。</p>
  </div>
</div>
<div id="toast" class="toast" hidden></div>
<script type="application/json" id="data">${json}</script>
<script>${CLIENT}</script>
</body>
</html>`
}

const CSS = String.raw`
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
`

const CLIENT = String.raw`
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
      toast("提交失败（" + error.message + "）。Agent 可能已停止等待，请回到 opencode 查看。");
    });
  }

  state.annotations.forEach(restoreHighlight);
  renderList();
  renderDiff();
  renderPrevious();
})();
`
