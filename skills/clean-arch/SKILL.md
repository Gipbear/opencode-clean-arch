---
name: clean-arch
description: End-to-end workflow that turns an agent-grown, hard-to-read Python (and small frontend) codebase into one clean architecture with no leftover versions, plus short 4+1 design docs. Use when the user asks to clean up, restructure, refactor, simplify, de-duplicate or document the architecture of a repository or subsystem, or runs /clean-arch.
---

# Clean architecture workflow

The goal is a codebase where each concept has exactly one implementation, every
module has one clear responsibility, nothing from earlier attempts is left behind,
and a short set of design documents matches the code.

This skill orchestrates the others. Load each one when its phase starts:
`arch-diagnose`, `arch-plan`, `restructure-modules`, `simplify-code`,
`clean-finish`, `comment-hygiene`, `arch-map`.

## Rules that hold in every phase

0. **Project rules come first.** Read `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*` and similar
   instruction files before anything else. Their conventions (test command, style, directories
   that must stay) override this skill's defaults. If a finding contradicts them, list it under
   open questions; never decide it silently.
1. **Diagnosis and planning are read-only.** Until the plan is approved, do not edit,
   move or delete anything outside `.clean-arch/`. Reading, searching and running
   tests or the analysis tools is fine.
2. **No change without an approved plan.** Approval comes from the review page
   (`clean_arch_review`) or, if that tool is unavailable, an explicit "approved" in chat.
3. **No compatibility layers inside the repository.** When code moves, is renamed or is
   merged, update every caller in the same step and delete the old code. No aliases,
   re-exports, wrapper functions, deprecation warnings, feature flags or `_old`/`_v2`
   copies. The only exceptions are the *external contracts* listed in the approved plan:
   things outside the repository depend on them (published package API, CLI flags used
   by external scripts, files on disk such as checkpoints or caches, network APIs,
   database schemas). Anything not on that list may change freely.
4. **Behavior is preserved.** After each step, the verification agreed in the plan passes.
   Pre-existing failures recorded in the baseline do not block, and new ones do.
5. **Evidence over impressions.** Every finding, decision and diagram element points to
   a file and line or to tool output. Do not draw or describe anything you have not read.
6. **Keep the user's attention budget.** Human-facing output is short. Put detail that
   only agents need into `.clean-arch/`.
7. **Language.** Human-facing text uses the language the project instructions ask for,
   otherwise the language of the user's request. Code identifiers stay as they are.

`.clean-arch/` is local working state and is never committed. Before writing anything there,
add `.clean-arch/` to the repository's local ignore file (the path printed by
`git rev-parse --git-path info/exclude`), so tracked files such as `.gitignore` stay untouched;
use `.gitignore` only if the project instructions ask for that. Plans, reviews and the agent
index stay on this machine. What other people and later sessions must see belongs in
`docs/architecture/`; it is written to the working tree but **not committed by you**: the user
reviews the pages and commits them by hand. Helper scripts you write for checks go to
`.clean-arch/cache/`.

Do not run `git commit`, `git push`, `git stash`, `git reset` or branch-switching commands unless
the user asks. Leave all changes, including the documents, uncommitted in the working tree.

## Tools

| Tool | Use |
|---|---|
| `clean_arch_facts` | Deterministic facts: modules, imports, cycles, duplicates, hotspots, classes, draft Mermaid, rule checks, and `importers` (everything that references a module) |
| `clean_arch_leftovers` | Leftover scan: parallel versions, duplicates, broken imports, compat shims, commented code, debug output, narrative comments |
| `clean_arch_review` | `action: "open"` starts the browser review page and returns its URL (show it to the user); `action: "wait"` blocks until the user approves or requests changes |
| `clean_arch_render` | Renders `*.mmd` diagrams to SVG for code hosts that do not render Mermaid |
| `clean_arch_perf` | Used by `perf-tune`: static slow-pattern scan, environment probe, repeated benchmark with baseline comparison, and the lessons store |

If the tools are not registered, run the scripts directly from this skill's directory:
`python3 scripts/arch_facts.py --root <repo> summary` and
`python3 scripts/leftover_scan.py --root <repo>` (add `--help` for options; it exits 0 unless
`--fail-on` is given). Without the
review tool, show the plan path and ask the user to approve it in chat.

## Phases

### 0. Scope and baseline

- Scope is the whole repository unless the user named a subsystem (`$ARGUMENTS` of
  `/clean-arch`, or the request).
- Make sure `.clean-arch/` is ignored locally (see above) before writing any file there.
- Find the test command (project instructions first, then pytest config, `tests/`, Makefile,
  CI files, README). Run it once with `PYTHONDONTWRITEBYTECODE=1` so the read-only phases leave
  no `__pycache__` behind. Record the result as the baseline, including tests that already fail.
- If some tests need dependencies or hardware that are not available (GPU, multi-GB packages),
  install only light dependencies and record pass/error per test module. Cover the rest with
  smoke checks: `python -m compileall -q <pkgs>` plus an import sweep of modules that do not
  need the missing packages. Plan steps whose only coverage needs the missing environment are
  marked "verify in <env>".
- If there are no tests, define smoke checks in the plan: import every touched module, run the
  main CLI with `--help`, and run one small end-to-end command when one exists.
- Run `clean_arch_facts` (summary, and `brief: true` for the numbers table) and
  `clean_arch_leftovers`. Record the headline numbers: files, lines, duplicates, cycles, broken
  imports, and leftovers by severity. If either output carries a "Warning" about incomplete
  imports, spot-check with `rg` as described in `arch-diagnose` before using the numbers.
- Note the git state: the current branch, uncommitted changes (ask before touching a dirty
  tree), and the base commit. Later phases diff against this base.
- Write `.clean-arch/baseline.md`: test command and result, the headline numbers, and the
  base commit.

### 1. Diagnose

Load `arch-diagnose`. Output: `.clean-arch/diagnosis.md`.

### 2. Plan and review

Load `arch-plan`. Write `.clean-arch/plan.md`, then submit it with `clean_arch_review`.
Revise until the user approves. When phases 1 and 2 run back to back, send one chat message:
the diagnosis summary plus the review link. If the work is large, split it into several plans
(one per subsystem, each ≤ 8 steps). List findings left for later plans under "Not doing" with
the plan they belong to. Run each plan through phases 3–5 before starting the next.

### 3. Execute

Follow the approved plan step by step. Use `restructure-modules` for module, package and
class moves, merges, splits and cycle breaks. Use `simplify-code` for function-level
cleanup inside the code you touch. After every step:

- run that step's verification, plus `clean_arch_facts` with no new unresolved imports;
- if it fails, fix it within the step or revert the step's files. Never continue on red.

If reality contradicts the plan (a hidden caller, an external user of an API), stop. Explain
the conflict, update the plan, and get approval again for the changed part.

### 4. Finish gate

Load `clean-finish` and `comment-hygiene`. The gate must pass before docs are written.

### 5. Document

Load `arch-map`. It writes `docs/architecture/` (4+1 views, short, with SVG diagrams) and the
agent-facing files in `.clean-arch/`, then renders and checks diagrams against the code.

### 6. Report

Reply in the user's language, at most one screen:
- what changed, with before/after numbers from `clean_arch_facts` and `clean_arch_leftovers`;
- what was deleted (modules, files, duplicate copies);
- the external contracts that were kept;
- remaining risks or follow-ups;
- where the docs are.

## Partial requests

| Request | Do |
|---|---|
| "draw / document the architecture" | `arch-map` only (no source changes) |
| "review / diagnose the architecture" | phases 0–1, then show the diagnosis |
| "plan a cleanup" | phases 0–2 |
| "simplify this file/function" | `simplify-code` on that scope, then `clean-finish` on the diff |
| "check for leftovers" | `clean-finish` only |
| "make it faster / why is it slow" | `perf-tune`, preferably after the cleanup so one implementation is measured; this workflow does not tune performance by itself |
