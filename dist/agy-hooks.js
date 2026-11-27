#!/usr/bin/env node

// src/adapters/agy-hooks.ts
import path2 from "node:path";

// src/review/state.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
var VALID_PHASES = /* @__PURE__ */ new Set(["diagnose", "awaiting_approval", "executing", "done"]);
var DEFAULT_TTL_MINUTES = 240;
function isPathInside(rootDir, targetPath, allowSame = false) {
  const base = path.resolve(rootDir);
  const full = path.resolve(base, targetPath);
  const normBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normFull = process.platform === "win32" ? full.toLowerCase() : full;
  if (normBase === normFull) return allowSame;
  const rel = path.relative(normBase, normFull);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function stateFilePath(root) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ".clean-arch", "state.json");
  if (!isPathInside(resolvedRoot, target)) {
    throw new Error("Invalid state file path outside workspace root");
  }
  return target;
}
async function readWorkflowState(root) {
  try {
    const raw = await readFile(stateFilePath(root), "utf8");
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
function isReadOnlyPhase(state, nowMs = Date.now()) {
  if (!state || state.phase !== "diagnose" && state.phase !== "awaiting_approval") {
    return false;
  }
  const ttlMinutes = Number(process.env.CLEAN_ARCH_STATE_TTL_MIN ?? DEFAULT_TTL_MINUTES);
  const effectiveTtlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 6e4;
  if (state.updatedAt) {
    const updatedMs = Date.parse(state.updatedAt);
    if (Number.isFinite(updatedMs) && nowMs - updatedMs > effectiveTtlMs) {
      return false;
    }
  }
  return true;
}

// src/adapters/agy-hooks.ts
var WRITE_TOOLS = /* @__PURE__ */ new Set([
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content"
]);
function extractTargetPath(args) {
  if (!args) return null;
  for (const key of ["Path", "TargetFile", "path", "file_path", "filePath", "target_file"]) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}
function isAllowedWriteTarget(root, targetPath) {
  const resolvedRoot = path2.resolve(root);
  const resolvedTarget = path2.resolve(resolvedRoot, targetPath);
  if (!isPathInside(resolvedRoot, resolvedTarget, true)) {
    return true;
  }
  const cleanArchDir = path2.join(resolvedRoot, ".clean-arch");
  const archDocsDir = path2.join(resolvedRoot, "docs", "architecture");
  const gitExclude = path2.join(resolvedRoot, ".git", "info", "exclude");
  return isPathInside(cleanArchDir, resolvedTarget, true) || isPathInside(archDocsDir, resolvedTarget, true) || isPathInside(gitExclude, resolvedTarget, true);
}
async function evaluatePreToolUse(payload) {
  const toolName = payload.toolCall?.name ?? "";
  if (!WRITE_TOOLS.has(toolName)) {
    return { decision: "allow" };
  }
  const root = payload.cwd || payload.workspacePaths?.[0];
  if (!root) {
    return { decision: "allow" };
  }
  const state = await readWorkflowState(root);
  if (!isReadOnlyPhase(state)) {
    return { decision: "allow" };
  }
  const targetPath = extractTargetPath(payload.toolCall?.args);
  if (!targetPath || isAllowedWriteTarget(root, targetPath)) {
    return { decision: "allow" };
  }
  const phaseLabel = state?.phase === "diagnose" ? "\u67B6\u6784\u8BCA\u65AD" : "\u65B9\u6848\u5F85\u8BC4\u5BA1";
  return {
    decision: "deny",
    reason: `Clean-Arch \u95E8\u7981\u62E6\u622A\uFF1A\u5F53\u524D\u5DE5\u4F5C\u533A\u5904\u4E8E\u3010${phaseLabel}\u3011\u53EA\u8BFB\u9636\u6BB5\uFF08${state?.doc ?? ".clean-arch/plan.md"}\uFF09\uFF0C\u5728\u8BC4\u5BA1\u6279\u51C6\u524D\u7981\u6B62\u4FEE\u6539\u4E1A\u52A1\u6587\u4EF6 ${targetPath}\u3002\u82E5\u5DF2\u653E\u5F03\u672C\u6B21\u91CD\u6784\uFF0C\u53EF\u5220\u9664 .clean-arch/state.json \u89E3\u9664\u53EA\u8BFB\u4FDD\u62A4\u3002`
  };
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function runAgyPreToolUseHook() {
  try {
    const raw = await readStdin();
    let payload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        process.stdout.write(JSON.stringify({ decision: "allow" }));
        return;
      }
    }
    const result = await evaluatePreToolUse(payload);
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
}

// <stdin>
void runAgyPreToolUseHook();
