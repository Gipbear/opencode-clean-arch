---
name: clean-arch
description: End-to-end workflow that turns a scattered, chat-grown Python (and small frontend) codebase into an immediately readable architecture with an explicit spine, dataclass contracts, flat 3-layer modules, zero leftover versions, and short 4+1 SVG docs via two-round review. Use when cleaning up, restructuring, refactoring or documenting a repo, or on /clean-arch.
---

# Clean architecture workflow

Chat-grown codebases rarely suffer from too few design patterns; they suffer from **missing
backbone**: logic scattered across ad-hoc scripts, domain concepts hidden inside `dict[str, Any]`
bags, orchestration tangled with low-level I/O, and dead copies left behind from earlier prompts.

The goal is a codebase a teammate can grasp in five minutes:
1. **One explicit spine (storyline)** per workflow that reads like a table of contents;
2. **Visible data contracts** (`@dataclass` models) instead of mystery dicts;
3. **Flat, cohesive modules** in at most three layers with zero speculative bloat;
4. **Nothing left behind** from earlier attempts, backed by concise 4+1 SVG docs.

This skill orchestrates the others. Load each one when its phase starts:
`arch-diagnose`, `arch-plan`, `restructure-modules`, `simplify-code`,
`clean-finish`, `comment-hygiene`, `arch-map`.

## The target architecture standard (clear spine, zero bloat)

Every diagnosis, plan and refactor aims at these four rules unless project instructions say
otherwise:

1. **Explicit spine, deep modules.** Each major workflow has one thin orchestrator
   (`pipeline.py`, `workflow.py`, `service.py`, typically 30–50 lines) that states *what* happens
   step by step (`load -> retrieve -> score -> render`) and delegates *how* to cohesive domain
   modules. Orchestrators do not inline parsing, math or retry loops; domain modules do one job
   deeply and do not secretly chain upstream/downstream workflows.
2. **Data shapes first (`@dataclass` over raw dicts).** Core domain concepts, inputs and outputs
   crossing module boundaries are explicit `@dataclass` types (or existing `BaseModel` /
   `TypedDict` at JSON boundaries) in a clear place (`models.py` / `types.py`), typically 4–8
   types per subsystem. Reading the data models plus the spine should explain 80% of the module.
3. **Flat 3-layer dependency flow (strictly top-down):**
   - **Entry & Spine**: CLI, HTTP routes, job runners, and thin workflow orchestrators (own I/O
     sequencing).
   - **Domain Capabilities**: modules named after domain concepts; take and return explicit data
     models; kept free of direct disk, network and framework I/O wherever practical.
   - **Infrastructure & IO**: file formats, databases, HTTP/LLM clients, environment/config
     loading — exactly one home per external boundary instead of scattering `open()`, `requests`
     or `os.getenv()` across domain logic.
4. **Four anti-bloat red lines:**
   - **No single-implementation `ABC`, `Protocol`, `Factory` or `Registry`** — one implementation
     calls the concrete class or function directly; two real implementations in this repo justify
     an abstraction.
   - **No pass-through wrappers** — if deleting a layer moves zero complexity into callers, delete
     it.
   - **No micro-file fragmentation** — do not create a package or file for one 30-line helper;
     prefer deep modules with a small public surface.
   - **No `utils.py` / `common.py` / `helpers.py` grab-bags** — place helpers as private `_fn`
     functions next to their caller or inside a domain-named module.

## Rules that hold in every phase

0. **Project rules come first.** Read `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*` and similar
   instruction files before anything else. Their conventions (test command, style, directories
   that must stay) override this skill's defaults. If a finding contradicts them, list it under
   open questions; never decide it silently.
1. **Diagnosis and planning are read-only.** Until a plan is approved, do not edit, move or
   delete anything outside `.clean-arch/`. Reading, searching and running tests or analysis tools
   is fine.
2. **No change without an approved plan.** Approval comes from `clean_arch_review` or, if that
   tool is unavailable, an explicit "approved" in chat.
3. **No compatibility layers inside the repository.** When code moves, is renamed or is merged,
   update every caller in the same step and delete the old code. No aliases, re-exports, wrapper
   functions, deprecation warnings, feature flags or `_old`/`_v2` copies. The only exceptions are
   the *external contracts* listed in the approved plan (published package API, CLI flags used by
   external scripts, checkpoints/saved files on disk, network APIs, database schemas).
4. **Behavior is preserved.** After each step, the verification agreed in the plan passes.
   Pre-existing failures recorded in the baseline do not block, and new ones do.
5. **Evidence over impressions.** Every finding, decision and diagram element points to a file
   and line or to tool output. Do not draw or describe anything you have not read.
6. **Keep the user's attention budget.** Human-facing output is short. Put detail that only
   agents need into `.clean-arch/`.
7. **Language.** Human-facing text uses the language the project instructions ask for, otherwise
   the language of the user's request. Code identifiers stay as they are.

`.clean-arch/` is local working state and is never committed. Before writing anything there, add
`.clean-arch/` to the repository's local ignore file (`git rev-parse --git-path info/exclude`),
so tracked files such as `.gitignore` stay untouched; use `.gitignore` only if project
instructions ask for that. `docs/architecture/` is written to the working tree and **not
committed by you**: the user reviews and commits it by hand. Helper scripts go to
`.clean-arch/cache/`.

Do not run `git commit`, `git push`, `git stash`, `git reset` or branch-switching commands unless
the user asks.

## Tools

| Tool | Use |
|---|---|
| `clean_arch_facts` | Deterministic facts + architectural signals: modules, cycles, `data_models`, `architecture_signals` (tangled orchestrators, repeated dict shapes, weak dict boundaries, impure shared/core modules, scattered I/O, grab-bags, single-impl ABCs), duplicates, hotspots, draft Mermaid, `importers` and diagram `verify` |
| `clean_arch_leftovers` | Hygiene scan: parallel versions, duplicates, broken imports, compat shims, commented code, debug output, narrative comments, unreferenced symbols |
| `clean_arch_review` | `action: "open"` starts the browser review page and returns its URL (show it to the user); `action: "wait"` blocks until the user approves or requests changes |
| `clean_arch_render` | Renders `*.mmd` diagrams to self-contained SVG for code hosts that do not render Mermaid |
| `clean_arch_perf` | Used by `perf-tune`: static slow-pattern scan, environment probe, repeated benchmark with baseline comparison, and the lessons store |

If the tools are not registered, run the scripts directly from this skill's directory:
`python3 scripts/arch_facts.py --root <repo> summary` and
`python3 scripts/leftover_scan.py --root <repo>` (exits 0 unless `--fail-on` is given). Without
the review tool, show the plan path and ask the user to approve it in chat.

## Phases (Two-Round Approval Workflow)

Restructuring messy code on top of dead copies and parallel files creates huge, risky diffs;
stopping after deleting dead code leaves the architecture just as tangled as before. Therefore,
any codebase with structural issues runs in **two distinct plan-and-execute rounds**:
- **Round 1** aligns on the **Target Architecture Blueprint** up front while executing **only
  hygiene & dead-code removal** to shrink the codebase safely.
- **Round 2** executes the **spine extraction, `@dataclass` contracts, I/O isolation and module
  boundary restructuring** on the clean tree.

### 0. Scope and baseline

- Scope is the whole repository unless the user named a subsystem (`$ARGUMENTS` of `/clean-arch`,
  or the request).
- Make sure `.clean-arch/` is ignored locally before writing any file there.
- Find the test command (project instructions first, then pytest config, `tests/`, Makefile, CI
  files, README). Run it once with `PYTHONDONTWRITEBYTECODE=1` so read-only phases leave no
  `__pycache__` behind. Record pass/fail as the baseline.
- If some tests need unavailable hardware or heavy packages (GPU, multi-GB deps), install only
  light dependencies, record pass/error per module, and define smoke checks (`python -m compileall
  -q <pkgs>` plus an import sweep). Mark GPU-only steps "verify in <env>".
- If there are no tests, define smoke checks in the plan: import every touched module, run the
  main CLI with `--help`, and run one small end-to-end command when one exists.
- Run `clean_arch_facts` (summary, plus `brief: true`) and `clean_arch_leftovers`. Spot-check
  with `rg` if any incomplete-import warning appears (see `arch-diagnose`).
- Note the current branch, uncommitted changes (ask before touching a dirty tree), and the base
  commit. Write `.clean-arch/baseline.md`.

### 1. Diagnose architecture and hygiene

Load `arch-diagnose`. Output: `.clean-arch/diagnosis.md` — structural architecture findings
(missing/tangled spine, implicit dict contracts, leaked I/O, scattered concepts, wrong dependency
direction) come first, separated from hygiene leftovers.

### 2. Round 1 — Target Blueprint & Hygiene Sweep (Plan → Review → Execute)

Load `arch-plan` in **Round 1 mode**:
- Write `.clean-arch/plan.md` containing:
  1. the full **Target Architecture Blueprint** (target storyline/spine, proposed `@dataclass`
     contracts, flat 3-layer module table, before/after diagram) so the user reviews and shapes
     the destination before any code moves; and
  2. **Round 1 executable steps** (≤ 8 steps): strictly subtractive cleanup — collapse parallel
     versions (`*_v2`, copied directories/files), deduplicate identical helpers, fix/remove broken
     imports and internal compat shims, delete confirmed dead scripts/symbols.
- Submit `.clean-arch/plan.md` via `clean_arch_review` (when phases 1 and 2 run back to back,
  send one message with the short diagnosis summary and the review URL). Revise until approved.
- Execute Round 1 step by step (`restructure-modules`), verifying tests and `clean_arch_facts`
  after every step.
- *Fast-track check*: Only if the diagnosis found **zero** structural spine/contract/boundary
  issues (or the entire codebase is tiny enough that hygiene + structural changes fit cleanly in
  ≤ 5 steps already approved in Round 1), skip Phase 3 and go to Phase 4. **Never stop after
  hygiene cleanup when structural findings remain.**

### 3. Round 2 — Spine, Data Contracts & Module Boundaries (Plan → Review → Execute)

On the de-noised codebase, re-run `clean_arch_facts` summary to get fresh post-cleanup numbers,
then load `arch-plan` in **Round 2 mode**:
- Update `.clean-arch/plan.md` (and write `.clean-arch/rules.toml` encoding the 3-layer rules and
  forbidden imports) with **Round 2 executable steps** (≤ 8 steps per subsystem, bottom-up if
  multiple subsystems are needed):
  1. introduce explicit `@dataclass` contracts and replace cross-module raw `dict` bags;
  2. push scattered file/network/env I/O to single-home infrastructure modules;
  3. consolidate fragmented domain concepts, dissolve `utils/helpers` grab-bags, break cycles and
     fix upward layer imports;
  4. extract thin workflow spine functions (30–50 lines) and inline single-implementation
     abstractions or pass-through wrappers.
- Submit `.clean-arch/plan.md` via `clean_arch_review` for Round 2 sign-off (the review UI shows
  the diff against Round 1). Revise until approved.
- Execute Round 2 step by step (`restructure-modules` + `simplify-code`), running the step's
  verification and `clean_arch_facts` after every step. If reality contradicts the plan, stop,
  update the plan, and re-approve the affected part.

### 4. Finish gate

Load `clean-finish` and `comment-hygiene`. Both hygiene checks (`clean_arch_leftovers`) and
architectural alignment checks (`clean_arch_facts check` against `.clean-arch/rules.toml`, spine
and blueprint completion) must pass before docs are written.

### 5. Document

Load `arch-map`. Write `docs/architecture/` (4+1 views highlighting the spine, core `@dataclass`
models and 3-layer module map, with rendered SVGs) and `.clean-arch/` agent index files, then
verify all diagrams against the code.

### 6. Report

Reply in the user's language, at most one screen:
- how the architecture changed (the new spine entry points, core data models introduced, and
  3-layer module layout);
- before/after numbers from `clean_arch_facts` and `clean_arch_leftovers`;
- what was consolidated or deleted;
- external contracts kept, remaining risks, and where `docs/architecture/` lives.

## Partial requests

| Request | Do |
|---|---|
| "draw / document the architecture" | `arch-map` only (no source changes) |
| "review / diagnose the architecture" | phases 0–1, then show the diagnosis summary |
| "plan a cleanup / refactor" | phases 0–2 up to Round 1 review (with full Target Blueprint) |
| "simplify this file/function" | `simplify-code` on that scope, then `clean-finish` on the diff |
| "check for leftovers" | `clean-finish` only |
| "make it faster / why is it slow" | `perf-tune`, preferably after `clean-arch` so only one clean implementation is profiled |
