---
name: arch-map
description: Generate short, code-verified architecture docs for a Python (and small frontend) repository - 4+1 views highlighting the workflow spine, core dataclass contracts and 3-layer module boundaries, rendered to self-contained SVG, plus agent-facing index and rules. Use on /arch-map or after clean-arch.
---

# Architecture map (4+1 views)

Documents the codebase **as it actually is now** so a newcomer can grasp its main storyline, core
data shapes and module boundaries in minutes. Never document wishful future states here; plans
belong in `.clean-arch/plan.md`. Prefer the `clean_arch_facts` and `clean_arch_render` tools
(scripts live in `../clean-arch/scripts/`).

Two audiences, two places:

| Place | Audience | Size |
|---|---|---|
| `docs/architecture/` | humans | each page ≤ ~80 lines, each diagram ≤ 20 nodes and ≤ ~1000 px wide; tables over prose |
| `.clean-arch/` | agents on this machine; local only, never committed | as detailed as useful; humans need not read it |

Write human docs in the language the project instructions ask for, otherwise the language the
project's docs mostly use. Keep code identifiers verbatim. Project rules in `AGENTS.md` /
`CLAUDE.md` override defaults.

## Procedure

1. **Collect facts.** Ensure `.clean-arch/` is ignored locally (`git rev-parse --git-path
   info/exclude`). Run `clean_arch_facts` `summary`, `json` (saved to
   `.clean-arch/cache/facts.json`), `mermaid --view packages`, and `mermaid --view classes` (with
   `focus` per subsystem).
   - Pay special attention to `Entry points`, `Explicit data models (@dataclass / BaseModel /
     TypedDict)`, `Core class candidates`, and `Process-level calls` (`subprocess` / shell script
     edges, drawn as `-.->|subprocess|`).
   - Remember that `mermaid --view classes` weights behavioural classes highest; manually include
     the **core `@dataclass` / domain data models** from `Explicit data models` in `logical.md`
     whenever they carry the main data flow between modules!

2. **Read the spine and boundaries.** Read `AGENTS.md`, entry points, workflow orchestrators,
   `models.py` / `types.py` data contracts, infrastructure clients, configs and deploy files. Be
   ready to answer clearly:
   - What does the system do, and where are the 1–3 main entry / spine functions?
   - What are the 4–8 core data structures flowing through that spine?
   - How do modules divide into Entry/Spine, Domain Capabilities, and Infrastructure/IO?
   - What runs as separate OS processes or external services, and what persists on disk?

3. **Write the human pages** from `references/templates/` following `references/views.md`:
   - Required: `README.md` (context + quick guide to reading the spine), `logical.md` (core
     domain data models + key services/collaborators), `development.md` (layered module map,
     dependency rules, "where new code goes"), `process.md`, `physical.md`, `scenarios.md` (2–4
     end-to-end sequence diagrams tracing the main workflow spines), and `decisions.md`.
   - Optional: `data.md` for ML / data-intensive repos (datasets, checkpoints, indexes, schemas).
   - Skip inapplicable subsections rather than padding. Link existing design docs from
     `README.md` without copying them.

4. **Render self-contained SVG diagrams.** Save Mermaid sources as
   `docs/architecture/diagrams/<view>-<name>.mmd` and run `clean_arch_render` to generate `.svg`
   files alongside them. Embed as:
   ```markdown
   ![模块依赖](diagrams/development-packages.svg)

   <sub>源文件: [development-packages.mmd](diagrams/development-packages.mmd)</sub>
   ```
   Supported Mermaid kinds: `flowchart`, `classDiagram`, `sequenceDiagram`, `stateDiagram-v2`,
   `erDiagram`. Fix every `?` renderer warning (see `references/views.md` — ASCII subgraph ids,
   no `<-->`, no `-.text.->`, width ≤ 1200 px) and re-render with `force: true`.

5. **Write agent-facing files** (templates in `references/templates/ai/`):
   - `.clean-arch/modules.md`: every package and key module — single responsibility, spine entry
     points, core symbols (`path:line`), dependencies, and explicit `Put here` / `Not here` rules
     so future chat sessions never dump glue code in random files.
   - `.clean-arch/glossary.md`: domain concept ↔ canonical code symbol / `@dataclass` name.
   - `.clean-arch/rules.toml`: layers (top-to-bottom), `no_cycles = true`, `[[forbid]]` rules
     (e.g. keeping domain modules free of direct HTTP/web/CLI imports), and size budgets. Run
     `clean_arch_facts` `check`; assign every non-exempt module to a layer. List any remaining
     layer/forbidden/cycle violations under "Known violations" in `development.md`, and full
     budget details in `.clean-arch/modules.md`.
   - Update or create a short "Architecture" section in `AGENTS.md` pointing to
     `docs/architecture/README.md` and `docs/architecture/development.md` (never reference
     uncommitted `.clean-arch/` paths in `AGENTS.md`).

6. **Verify against code (zero fabrication).**
   - Run `clean_arch_facts` `verify` on `docs/architecture` — fix every nonexistent symbol,
     unbacked import arrow (label non-import edges like `-->|HTTP|`) or wrong inheritance arrow.
   - Confirm all linked paths and file names exist, and every page stays ≤ ~80 lines / ≤ 20
     diagram nodes.

7. **Summarize for the user.** Point to `docs/architecture/README.md`, highlight which pages
   contain `(推断)` / `(inferred)` details to check first, and remind them that
   `docs/architecture/` is left uncommitted in the working tree for manual review.

## Updating existing docs

Update `docs/architecture/` in place: preserve accurate human notes, update changed modules/models,
delete removed symbols, re-render changed `.mmd` diagrams, and append new entries to
`decisions.md` (marking old ones superseded rather than rewriting history).
