---
name: arch-map
description: Generate short, code-verified architecture docs for a Python (and small frontend) repository - 4+1 views (logical class diagram, development/module view, process, physical, scenarios) plus data view and decisions, as Markdown with Mermaid sources rendered to SVG, and agent-facing module index, glossary and layer rules. Use when the user asks for architecture docs, class or design diagrams, or after a restructuring.
---

# Architecture map (4+1 views)

Documents the code **as it is now**. Never document a target state or an intention here; that
belongs in a plan. The facts scripts are in `../clean-arch/scripts/`. Prefer the
`clean_arch_facts` and `clean_arch_render` tools.

Two audiences, two places:

| Place | Audience | Size |
|---|---|---|
| `docs/architecture/` | humans | each page ≤ ~80 lines, each diagram ≤ 20 nodes and ≤ ~1000 px wide; tables over prose |
| `.clean-arch/` | agents | as detailed as useful; humans need not read it |

Write human docs in the language the project instructions ask for, otherwise the language the
project's docs mostly use. Keep code identifiers as they are. Follow the conventions in the
project's `AGENTS.md`/`CLAUDE.md`; they override this skill.

## Procedure

1. **Facts.** Add `.clean-arch/cache/` to `.gitignore` first. Then run `clean_arch_facts`
   summary, `json` (saved to `.clean-arch/cache/facts.json`), `mermaid --view packages` and
   `mermaid --view classes` with `focus` per subsystem. The class draft is ranked by
   architectural weight (abstractions with subclasses, classes holding collaborators, size);
   the summary's "Core class candidates" lists the ranking. "Process-level calls" lists
   modules started through `subprocess`/`python -m` or shell scripts; the import graph does not
   show them, so draw them as dashed `-.->|subprocess|` edges. These are drafts and evidence,
   not finished diagrams.
2. **Read the code that matters.** Read the project instruction files, the entry points, the
   core classes, config files, `Dockerfile`/compose/k8s files, launch scripts, the README and
   existing design docs. Answer these:
   - What does the system do, and for whom?
   - What are the 2–4 most important flows?
   - What runs as separate processes (servers, workers, training jobs, model servers)?
   - Where does it run, and what does it store?
3. **Write the pages** from `references/templates/`. See `references/views.md` for what each
   view must and must not contain. Required pages are `README.md`, `logical.md`,
   `development.md`, `process.md`, `physical.md`, `scenarios.md` and `decisions.md`. Add
   `data.md` when datasets, models, knowledge bases or generated artefacts are central (ML
   and data projects). Skip a section rather than pad it. Existing design or roadmap docs
   elsewhere in the repo are linked from `README.md` under "see also", never copied; if they mix
   current state and plans, say which parts are plans.
4. **Diagrams.** Write each diagram as `docs/architecture/diagrams/<view>-<name>.mmd`. Render
   them with `clean_arch_render` (all `.mmd` files in that directory) to `.svg` next to them.
   Embed them in the page as:
   ```markdown
   ![模块依赖](diagrams/development-packages.svg)

   <sub>源文件: [development-packages.mmd](diagrams/development-packages.mmd)</sub>
   ```
   SVG images display on any code host (GitHub, GitLab, CodeHub/CodeArts, Gitee) and in
   IDEs. Mermaid fences and HTML pages do not render everywhere. Mermaid types that render
   well: `flowchart`, `classDiagram`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`. The
   renderer reports `?` warnings for syntax it mishandles (see the renderer notes in
   `references/views.md`) and for SVGs wider than 1200 px or flatter than 3:1. Fix every
   warning and render again with `force`.
5. **Agent-facing files** (templates in `references/templates/ai/`):
   - `.clean-arch/modules.md`: every package and important module, with its responsibility,
     key symbols, what it depends on, and where new code of each kind should go.
   - `.clean-arch/glossary.md`: domain term, meaning, code name(s).
   - `.clean-arch/rules.toml`: layers (top to bottom) and forbidden imports that describe the
     current intended structure, plus size budgets. Take budgets from the project's stated
     limits if it has any, otherwise keep the template defaults; say which in a comment.
     Put vendored, legacy and original-paper code under `exempt`. Run `clean_arch_facts`
     `check`; its note lists modules that match no layer, so add them to a layer or to
     `exempt`. Layer, forbidden-import and cycle violations are listed one by one under
     "Known violations" in `development.md`. Budget violations appear there only as counts
     plus the worst three files; the full list goes under `## Known violations` in
     `.clean-arch/modules.md`.
   - In `AGENTS.md` (create it if missing; keep existing content and follow its own rules
     about what belongs there), add or update a short "Architecture" section that points to
     `docs/architecture/README.md` and `.clean-arch/modules.md` and tells agents to put code
     where `modules.md` says. If the repo uses this plugin, also tell them to run the
     `clean-finish` gate before finishing. A `CLAUDE.md` that only imports `AGENTS.md` stays
     as it is.
6. **Verify against the code** (anti-fabrication):
   - Run `clean_arch_facts` with `command: verify` on `docs/architecture` (it reads `.mmd`
     files and mermaid blocks in Markdown). It reports names that do not exist, dependency
     arrows between modules with no matching import, and wrong inheritance. Edges that are
     not imports (HTTP, files, data flow) must carry a label, `-->|HTTP|`; the check skips
     labelled and dashed edges.
   - Every class, module, process and file named in a table exists. Check with `rg`/`ls`.
   - Every relation in the class diagram is a real call, inheritance or composition.
   - Links between pages and to source files resolve.
   - The page and diagram budgets hold. If a diagram has more than 20 nodes, split it by
     package or collapse the leaves.
7. Tell the user where the docs are, which page to read first, and list anything you could
   not determine (for example, the deployment topology when no deploy files exist).

## Updating existing docs

When `docs/architecture/` exists, update it in place. Keep human-written sections that are
still true, fix what changed, and delete what no longer exists. Regenerate only the diagrams
whose `.mmd` changed. Append to `decisions.md`; never rewrite earlier decisions, but mark them
superseded.
