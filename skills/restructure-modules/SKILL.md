---
name: restructure-modules
description: Safe architectural and module-level refactoring in Python - extract workflow spines, promote raw dict bags to dataclasses, push I/O to infrastructure edges, consolidate scattered concepts, dissolve utils grab-bags, and collapse duplicates with zero compatibility shims. Use when executing approved plan steps.
---

# Restructuring modules, spines and boundaries

Every structural step obeys the same four-step safety loop:

1. **Find every reference before touching code.** Text search is the source of truth; static
   tools are the cross-check. For module `pkg/sub/mod.py` and symbol `Thing`:
   ```bash
   rg -n "pkg\.sub\.mod|pkg/sub/mod|from pkg\.sub import mod|\bThing\b" \
      --glob '!**/.clean-arch/**'
   ```
   Also run `clean_arch_facts` with `command: importers` and `target: pkg.sub.mod`. Cover
   relative imports, strings (`importlib.import_module`, YAML/Hydra `_target_`,
   `pyproject.toml` `entry_points`), shell scripts (`python -m ...`), Dockerfiles, CI,
   notebooks, `unittest.mock.patch("...")` targets, tests and frontend `fetch` routes.
2. **Apply the structural change and update every caller in the same step.**
3. **Delete the old code immediately.** Leave no `Old = New` alias, no `from new import *`
   forwarding file, no `try/except ImportError` fallback, no `use_legacy` flag, and no `_old` /
   `_v1` backup file. Git history is the backup.
4. **Verify before moving to the next step:**
   - run the step's test / smoke command from the plan;
   - run `python -m compileall -q <changed dirs>`;
   - run `clean_arch_facts` summary (no new unresolved imports, no new cycles);
   - confirm the `rg` search for removed names/paths returns nothing outside `.clean-arch/` and
     changelogs.

If a reference belongs to an external contract listed in the approved plan, handle it strictly
as the plan specifies; if it is an unexpected external dependency, stop and ask the user.

---

## Part A — Architectural Playbooks (Round 2: Spine, Contracts & Boundaries)

### 1. Extract an explicit workflow spine (thin orchestrator + deep modules)
When a 200-line script or tangled function mixes orchestration, parsing, domain math and I/O:
1. Identify the 3–6 domain stages of the workflow (e.g. `load_inputs -> build_candidates ->
   score_candidates -> write_report`).
2. Move the mechanics of each stage into the domain or infra module that owns that concept. Give
   each stage function a clear typed signature (explicit `@dataclass` inputs and outputs) that
   hides its internal loops, regexes and helper functions (`_helper`).
3. Rewrite the workflow entry function (in `pipeline.py` / `workflow.py` / `jobs.py`) so it is
   30–50 lines of flat, top-to-bottom step calls and boundary I/O — readable as a story on first
   glance.
4. Make CLI commands and HTTP handlers thin 10–20 line adapters that parse request/CLI arguments
   into a typed input object and call the spine function.
5. **Anti-bloat check:** Do *not* wrap every stage in a `StageRunner` class or `BaseStage(ABC)`.
   Plain functions on explicit `@dataclass` objects are simpler and easier to trace.

### 2. Promote implicit `dict` bags to `@dataclass` contracts
When multiple modules construct or index the same raw dictionary keys (`d["score"]`,
`d.get("total")`):
1. `rg` for the key strings to find every producer (`{...}`) and consumer (`[...]`, `.get(...)`,
   `**d`).
2. Define a `@dataclass` (add `frozen=True` when immutable, `slots=True` on Python 3.10+ when
   instantiated in bulk) in the domain's `models.py` / `types.py` with clear field types and
   sensible defaults only where genuinely optional.
3. Update all internal producers to return the `@dataclass` and all internal consumers to access
   `obj.field` directly — deleting redundant `d.get("field", ...)` guesswork inside trusted code.
4. If an external JSON API or file format requires a `dict` at the boundary, convert **once** at
   the edge (`dataclasses.asdict(obj)` or a small `from_payload()` / `to_payload()` helper at the
   serialization boundary), never inside domain modules.

### 3. Push I/O and config to the infrastructure edge (Functional Core, Imperative Shell)
When domain/core modules directly call `open()`, `json.load`, `requests`, SQL/LLM SDKs or
`os.getenv()`:
1. Move external reads/writes into a single-responsibility infrastructure module (e.g.
   `infra/storage.py`, `infra/llm_client.py`, `config.py`) so each external system or file format
   has **one** home in the repository.
2. Refactor the domain function to accept already-loaded data (or typed config) and return
   computed data/commands without performing side effects itself.
3. Let the top-level spine function sequence the shell: call infra to load -> call pure domain to
   compute -> call infra to persist or notify. This also eliminates upward `core -> services`
   imports at the root.

### 4. Consolidate scattered concepts & dissolve `utils.py` grab-bags
- **Scattered concept** (e.g. prompt formatting, entity normalisation or path building duplicated
  with slight variations across 4 files): create or pick one domain-named module (never `utils`),
  unify the canonical behaviour, update all 4 callers, and delete the local ad-hoc copies.
- **Dissolve `utils.py` / `common.py` / `helpers.py`**:
  - A function called by only one module moves into that module as a private `_helper`.
  - Cohesive functions sharing one domain concept move together into a module named after that
    concept (e.g. `text_norm.py`, `formatting.py`).
  - Delete the empty grab-bag file and verify zero remaining imports.

### 5. Break import cycles & invert upward dependencies
In order of preference:
1. **Invert side-effect triggers upward to the spine**: if `core.pricing` imports
   `services.notify` just to send a receipt after pricing, remove the call from `pricing` and let
   the service/spine call `pricing.total()` then `notify.send_receipt()`.
2. **Move shared data types/pure functions down**: place shared `@dataclass` models and constants
   in a leaf `models.py` / `types.py` module with zero internal upward imports.
3. **Merge split halves of one concept**: if `a.py` and `b.py` cannot live apart without calling
   each other, they are one cohesive module.
4. **Protocol at the boundary** *only* when 2+ real implementations exist in lower/peer packages.
   Never hide a real architectural cycle behind function-local imports; reserve `TYPE_CHECKING`
   strictly for type annotations.

### 6. Remove speculative abstractions & slim god classes
- **Single-implementation `ABC` / `Factory` / `One-method class`**: delete the `ABC` or factory,
  point callers directly at the concrete class (or collapse a stateless `__init__ + run()` class
  into a plain function).
- **Pass-through module/layer**: point callers at the real target and delete the middleman.
- **God class**: group methods by the subset of attributes they actually touch; extract cohesive
  state+behaviour into domain-named collaborators or pure helper functions, leaving a thin
  coordinator.

---

## Part B — Hygiene & File Mechanics (Round 1 & General Moves)

### Collapse parallel versions & duplicate code
1. Diff the copies (`diff -u a.py b.py` or `git diff --no-index`).
2. Pick the survivor (more callers, tests, recent bug fixes, or named in the plan).
3. Port **deliberate** behaviour differences; discard accidental drift (debug prints, renamed
   locals, dead branches). Ask if a behavioral difference is ambiguous.
4. Point all callers and worthwhile tests at the survivor, then delete the duplicate files/bodies.

### Move or rename a module / symbol
- Use `git mv` when moving whole files so blame/history survives.
- Fix relative imports inside the moved file, keyword arguments at call sites, `__all__`,
  docstrings and CLI/config string paths in the same step.
- Keep `__init__.py` minimal: expose only intentional package public API, never compatibility
  re-exports for old paths.

## Python & Frontend Pitfalls

- **PyTorch & pickles**: renaming `nn.Module` attributes breaks `state_dict` keys; moving pickled
  classes breaks `torch.load`. Treat saved checkpoints as external contracts unless the user
  explicitly approves regeneration/migration.
- **Mocks**: `patch("pkg.mod.Thing")` patches where `Thing` is looked up, not defined — update
  mock targets whenever imports move.
- **Import-time side effects**: when moving code that populated registries or configured logging
  at import time, convert it to explicit initialization called from the entry point if allowed by
  the plan, or verify registration still runs.
- **Frontend pages**: serve one canonical static folder; split giant inline scripts into plain ES
  modules (`api.js`, `state.js`, `render.js`) without introducing bundlers or frameworks; update
  `fetch` URLs in lockstep with backend route moves.
