# Architectural & Hygiene Smell Catalogue

Each smell lists how to detect it and the standard fix under our **Explicit Spine + `@dataclass`
Contracts + Flat 3-Layer + Zero Bloat** architecture standard. Project conventions in `AGENTS.md`
always win: if `AGENTS.md` explicitly mandates a pattern listed here, do not report it as a smell
unless it causes severe, concrete pain (and even then, put it under open questions).

## 1. Spine, Data Contracts & Layering (Primary Architectural Smells)

| Smell | Detect | Usual fix |
|---|---|---|
| **Missing or tangled spine** | No single place shows the 3–6 high-level steps of a workflow; `clean_arch_facts` flags `Tangled orchestrators` (>=40-line functions calling 2+ internal modules while doing direct I/O or >=3-level loops) | Extract one thin orchestrator function (30–50 lines) that reads like a story (`load -> retrieve -> score -> format`); push mechanics into deep domain modules |
| **Fragmented chat-grown workflows** | Multiple scripts or endpoints (`run_*.py`, `handle_*.py`, `process_*.py`) each re-implement a slightly different end-to-end glue pipeline | Unify shared stages into domain modules + one parameterised workflow spine; keep CLI/HTTP entry points as thin 15-line adapters |
| **Implicit dict data contract** | `clean_arch_facts` flags `Implicit data shapes` (same >=3 dict keys across modules) or `Weak dict/Any module boundaries`; readers must read 5 functions to know what keys a `dict` holds | Define a `@dataclass` (or `TypedDict` strictly at raw JSON boundaries) in `models.py` / `types.py`; convert once at the edge and pass typed objects internally |
| **Config / args god-bag** | Full `argparse.Namespace`, Hydra `DictConfig` or raw settings `dict` passed through 4+ layers down into leaf helpers | Parse config once at the entry layer; pass explicit typed parameters or a small focused `@dataclass` config to each capability module |
| **Impure domain / leaked I/O** | `clean_arch_facts` flags `Impure shared/core modules`; domain/calculation code directly calls `open()`, `json.load`, `requests`, SQL/LLM SDKs or `os.getenv()` | Functional Core, Imperative Shell: move I/O to the orchestrator or a single-purpose infra module; keep core domain functions pure (data in -> data out) |
| **Scattered external boundary** | `clean_arch_facts` flags `Scattered external I/O` (3+ modules reading `os.environ`, making HTTP/LLM calls, or parsing the same file format independently) | Give each external system or file format exactly one infrastructure module (`config.py`, `llm_client.py`, `store.py`); everyone else goes through it |
| **Wrong dependency direction / cycle** | `clean_arch_facts` `package_cycles` / `module_cycles`, or domain/core importing `serving`, `web`, `cli` or `scripts` | Enforce top-down flow (`Entry/Spine -> Domain -> Infra`): invert upward calls so the orchestrator calls domain first and passes the result to notification/serving |

## 2. Cohesion & Anti-Bloat (Module & Class Design Smells)

| Smell | Detect | Usual fix |
|---|---|---|
| **Scattered domain concept** | One concept (entity normalisation, prompt assembly, path layout, retry policy, metric math) implemented ad-hoc in 3+ places with different names | Consolidate into one domain-named module with one canonical vocabulary |
| **Grab-bag module** | `clean_arch_facts` flags `Grab-bag modules` (`utils.py`, `common.py`, `helpers.py`, `misc.py` with unrelated functions) | Move single-caller helpers as private `_fn` into their caller; group cohesive helpers into a named module (e.g. `text_norm.py`) and delete `utils.py` |
| **Speculative single-impl abstraction** | `clean_arch_facts` flags `abstract X has 0/1 subclass(es)`, or a `Factory` / `Registry` / `Builder` wraps a single concrete implementation | Delete the `ABC` / `Protocol` / `Factory` and use the concrete class or function directly |
| **Pass-through layer / micro-files** | Module or service method that only forwards arguments to another module (fails the deletion test), or 5 tiny 20-line files that only make sense together | Inline pass-through wrappers; merge fragmented micro-files into one deep module with a small public API |
| **One-method pseudo-class** | `clean_arch_facts` flags `class X only has __init__ + run()` with no mutable lifecycle or shared state across methods | Replace with a plain function (or pass config `@dataclass` to a function) |
| **God class / mixed-state class** | > 300 lines with disjoint method/attribute groups, or attributes set conditionally outside `__init__` ("only valid after `.prepare()`") | Split cohesive state+behaviour into named collaborators, or split two lifecycle stages into two distinct data types (`RawBatch` -> `PreparedBatch`) |
| **Hidden global state & import side effects** | `clean_arch_facts` flags `global_effects`: module-level mutable caches/dicts mutated at runtime, `sys.path.insert(...)`, or file/network/model loading at `import` time | Own state explicitly in an object created by the entry point; move import-time work into explicit init/load functions; run via `python -m pkg.entry` instead of `sys.path` hacks |

## 3. Function-Level Readability Smells

| Smell | Detect | Usual fix |
|---|---|---|
| **Mixed abstraction levels** | Function interleaves high-level business steps with byte decoding, regexes or tensor indexing | Keep top-level steps at one abstraction level; extract low-level mechanics into private `_helpers` |
| **Deep nesting & flag switches** | Nesting >= 4; `def run(x, use_new=True, legacy_mode=False)` | Guard clauses / early return; split flag-switched behaviours into distinct functions or delete the dead branch |
| **Too many parameters** | >= 6 parameters threaded unchanged across calls | Group cohesive fields into a `@dataclass(frozen=True)` |
| **Defensive noise** | `try: ... except Exception: pass` swallowing bugs, or repeated `isinstance`/`None` checks inside trusted internal code | Validate once at system boundaries; let internal invariant bugs raise immediately |

## 4. Hygiene & Refactor Leftovers (Round 1 Sweep Targets)

- **Parallel versions**: `foo.py` + `foo_v2.py`, copied folders (`web/` + `web_copy/`), `Thing` + `ThingNew`, or renamed-variable function clones.
- **Compatibility shims inside the repo**: `OldName = NewName` aliases, forwarding re-export modules, `try/except ImportError` internal fallbacks, `@deprecated` wrappers, `use_legacy` flags.
- **Broken leftovers**: unresolved internal imports, shell scripts passing removed CLI flags, docs naming deleted files, commented-out code blocks, `breakpoint()` / stray library `print()`, edit-narration comments (`# changed to v2`).
- **PyTorch / Checkpoint external contracts**: renaming `nn.Module` attributes changes `state_dict` keys; moving pickled classes breaks `torch.load`. Treat saved checkpoints as external contracts unless the user confirms regeneration.

## 5. Small Frontend Pages

- Duplicated HTML/JS/CSS folders: keep one canonical directory served by the backend.
- Giant inline `<script>` mixing `fetch`, mutable globals and `innerHTML`: split into plain ES modules (`api.js`, `state.js`, `render.js`) with zero build step or framework bloat.
- Remove dead selectors, `console.log` and `debugger`.
