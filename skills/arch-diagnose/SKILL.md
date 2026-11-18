---
name: arch-diagnose
description: Read-only architecture diagnosis of a Python (and small frontend) codebase - traces the workflow spine, implicit dict contracts, I/O boundaries, scattered domain concepts and layer violations first, separating structural design flaws from dead-code hygiene leftovers. Use before restructuring or on /arch-diagnose.
---

# Architecture diagnosis

Read-only. Write only `.clean-arch/diagnosis.md` (and scratch evidence under
`.clean-arch/cache/`). `.clean-arch/` is never committed: ensure it is listed in the local
ignore file (`git rev-parse --git-path info/exclude`) before writing there.

The analysis scripts live in `../clean-arch/scripts/`. Prefer the `clean_arch_facts` and
`clean_arch_leftovers` tools when available.

**Core principle: do not confuse code hygiene with software architecture.** `leftover_scan` will
happily list 100 unused helpers, commented-out lines and `*_v2` files. If you let those fill the
diagnosis, the refactor will only sweep trash and leave the remaining code just as scattered and
unreadable. Diagnose **backbone, data shapes, module boundaries and I/O isolation** first; group
hygiene leftovers into their own secondary section for Round 1 cleanup.

## Procedure

1. **Collect deterministic facts.** Run:
   - `clean_arch_facts` summary (add `include` for a subsystem);
   - `clean_arch_leftovers`;
   - 6-month file churn, because high churn multiplies the cost of tangled design:
     ```bash
     git log --since=6.months --name-only --format= -- '*.py' | sort | uniq -c | sort -rn |
       while read n f; do [ -f "$f" ] && echo "$n $f"; done | head -30
     ```
   **Verify graph completeness before trusting counts.** Static import parsing misses dynamic
   imports or custom `PYTHONPATH` roots. Whenever `clean_arch_facts` or `clean_arch_leftovers`
   prints a "Warning" about imports treated as external, or reports >= 1/3 of modules as
   unreferenced/never imported:
   - pick three reported modules or classes and `rg -n "<module>|<ClassName>"` across the repo;
   - if `rg` finds real imports the tool missed, stop: record the mismatch under "Open questions"
     and tell the user rather than ranking deletions or drawing broken graphs;
   - if `rg` confirms them, note that in one line under "Numbers".

2. **Trace the real workflows top-down (mandatory code reading).**
   Read `AGENTS.md` / `CLAUDE.md` and `README.md` first, then open the actual entry points (CLI
   commands, `__main__` scripts, HTTP routes, job runners) and **trace 1–3 primary end-to-end
   flows through the code**. Evaluate the codebase through five architectural lenses (cross-check
   with `references/smells.md` and the `architecture_signals` sections of `clean_arch_facts`):
   - **Lens 1 — Workflow Spine (Storyline):** Can a newcomer open one orchestrator file and read
     the 3–6 high-level steps of the main flow in under 50 lines? Or is the flow split across
     ad-hoc scripts, or buried inside 200-line tangled functions (`Tangled orchestrators`) that
     mix step sequencing with regexes, math, retries and file paths?
   - **Lens 2 — Data Contracts:** What crosses module boundaries? Compare `Explicit data models`
     against `Implicit data shapes` and `Weak dict/Any module boundaries`. Are core domain
     concepts hidden in raw `dict[str, Any]` bags, positional tuples, or giant `cfg`/`args`
     objects threaded everywhere so readers must read every function body to know what keys exist?
   - **Lens 3 — Flat 3-Layer Boundaries & I/O Isolation:** Mentally map every module into three
     layers: **Entry & Spine** → **Domain Capabilities** → **Infrastructure & IO**. Check
     `Package-level import cycles`, upward imports (domain importing serving/CLI/scripts),
     `Impure shared/core modules`, `Scattered external I/O`, and `Module-level mutable state`.
     Are `open()`, `requests`, SQL/LLM calls or `os.environ` scattered inside domain logic
     instead of owned by thin edge/infra modules?
   - **Lens 4 — Cohesion & Scattered Concepts:** Did iterative chat development scatter one
     concept (config loading, prompt building, path conventions, metric calculation, entity
     normalisation) across 3+ unrelated files? Are there `utils.py` / `common.py` / `helpers.py`
     grab-bags (`Grab-bag modules`) or giant multi-responsibility modules?
   - **Lens 5 — Abstraction Fit (Anti-Bloat):** Check `Speculative abstractions & one-method
     classes` and apply the deletion test:
     - *Deletion test*: delete a module/wrapper in your head — if its complexity vanishes rather
       than reappearing in N callers, it is a pass-through layer and should go.
     - *Single-implementation seam*: an `ABC`, `Protocol`, `Factory` or `Registry` with <= 1
       concrete implementation in this repository is indirection, not architecture.
     - *Missing seam*: conversely, if 3+ real variants are selected by repeated `if kind == ...`
       ladders across several files, note the missing cohesive dispatch point.
     - *Keep harmless oddities*: standalone one-off experiment scripts that nothing imports can
       stay untouched under "Keep as is" if the user still wants them.

3. **Separate Architecture Findings from Hygiene Leftovers, then rank.**
   - **Architecture Findings (`A1`, `A2`, …)**: structural root causes from the five lenses above.
     Merge symptoms that share one root cause (e.g., five functions passing the same untyped
     result dict is **one** data-contract finding, not five). Score `impact (comprehension /
     change cost, 1–3) * spread (1–3) * churn (1–3)` and keep the top 5–10 structural findings.
   - **Hygiene & Leftover Sweep (`H1`, `H2`, …)**: parallel versions (`*_v2`, copied trees/files),
     exact/renamed duplicate helpers, broken imports, internal compatibility shims, dead modules,
     debug prints and commented-out code. Diff duplicate pairs (`diff -u a.py b.py`) to see which
     copy has newer fixes, and run `clean_arch_facts` `importers` before proposing any deletion.

4. **Sketch the Proposed Target Skeleton.**
   Before ending diagnosis, write a crisp sketch (10–20 lines) of what the code *should* look
   like after Round 2: the thin spine entry point(s), the 4–8 core `@dataclass` contracts to
   introduce/keep, and the flat 3-layer module grouping. This bridges diagnosis directly into
   `arch-plan`.

5. **Write `.clean-arch/diagnosis.md`** in the language rule of `clean-arch`, then reply in chat
   with a concise 6–12 line summary (main architectural bottlenecks + proposed spine + hygiene
   headline), not the whole file.

## Output format

```markdown
# Architecture diagnosis: <scope>

## Current state & storyline check
- **What the system does**: <1-2 sentences>
- **Current main flows**: <entry point -> actual call path today, and why the spine is clear or hard to follow>
- **Data contract maturity**: <explicit models today vs. where raw dicts / loose params dominate>

## Numbers
| Metric | Value |
|---|---|
| Python files / lines | … |
| Explicit data models / repeated implicit dict shapes | … |
| Package cycles / module cycles | … |
| Tangled orchestrators / impure shared modules / grab-bags | … |
| Duplicate groups / identical files | … |
| Broken internal imports / leftovers (high / medium) | … |

## Architecture findings (for Round 2 structural refactor)
| ID | Lens | Problem | Evidence | Target direction |
|---|---|---|---|---|
| A1 | spine | Main workflow is split across 3 scripts mixing CLI, HTTP and scoring loops | `run_a.py:42`, `srv/ask.py:88` | Extract thin `pipeline.run_query()` orchestrator; push scoring & HTTP down |
| A2 | contract | Retrieval candidates pass as 6-key raw dicts across 4 modules | `retriever.py:55`, `ranker.py:31` | Define `@dataclass Candidate` in `models.py` |
| A3 | io-layer | Core `pricing.py` calls notification service & reads env directly | `core/pricing.py:8` | Invert: `services` calls pure `core.pricing`, then dispatches notification |

`Lens` is one of: `spine` / `contract` / `io-layer` / `cohesion` / `bloat`.

## Proposed target skeleton (flat 3-layer, zero bloat)
- **Spine (Entry & Orchestration)**: `<module(s)>` — <3-5 step storyline>
- **Core `@dataclass` contracts**: `<ModelA(fields...)>`, `<ModelB(...)>`
- **Domain capability modules**: `<mod1>` (<responsibility>), `<mod2>` (<responsibility>)
- **Infrastructure & IO homes**: `<infra_mod>` (<external boundary owned>)

## Hygiene & leftover sweep (for Round 1 cleanup)
| ID | Kind | Item | Evidence | Action & caller check (`importers`) |
|---|---|---|---|---|
| H1 | parallel-version | `billing_v2.py` is identical to `billing.py` | `leftovers` | Delete `billing_v2.py` (0 importers) |
| … |

## Keep as is
- `<path>`: <why it looks unusual but earns its keep or is an isolated experiment>

## External contracts (proposed)
- <CLI flags, HTTP endpoints, saved checkpoints/files, published API that must stay compatible>

## Open questions
- <decisions only the user can make>
```

Keep `.clean-arch/diagnosis.md` under ~10,000 characters. Put exhaustive duplicate tables, raw
scores and full `importers` dumps into `.clean-arch/cache/diagnosis-evidence.md` and link to it.
