# Smell catalogue

Each smell lists how to detect it and the usual fix. The fix is a direction for the plan, not
a licence to start editing. Project conventions win: if `AGENTS.md` asks for something listed
here (for example, ABCs for every interface), do not report it as a smell. Mention the
conflict under open questions only if it causes real cost.

## System and package level

| Smell | Detect | Usual fix |
|---|---|---|
| Parallel versions | identical or near-identical files in two trees; `foo.py` + `foo_v2.py`; `Thing` + `ThingNew` | pick one survivor, port deliberate differences, delete the rest, update callers |
| Package cycle | `clean_arch_facts` cycles | move the shared piece down into a lower package; split a package that mixes two layers |
| Wrong dependency direction | core/domain imports serving, web, CLI or experiment code | invert by moving the dependency to the edge; pass data, not frameworks, inward |
| Scattered concept | one concept (prompt templates, config, KB access) implemented in 3+ places | one module owns it; others call it |
| Script sprawl | dozens of `run_*.py` / `ch5_*.py` with copy-pasted setup | shared setup in one module; scripts become thin entry points; delete scripts that are broken or superseded (a script imported by other scripts counts as referenced) |
| Broken leftovers | imports of modules that no longer exist; shell scripts passing CLI flags the target no longer defines (`--help` exits 2); `sys.path` imports from missing or gitignored directories; docs or `AGENTS.md` naming files that do not exist; scripts doing file IO at import time | delete the dead caller, or fix the reference; never leave it broken |

## Module level

| Smell | Detect | Usual fix |
|---|---|---|
| Grab-bag module | `utils.py`, `common.py`, `helpers.py` with unrelated functions | move each function next to its only caller or into a named module |
| Pass-through layer | module whose functions only forward to another | inline and delete (deletion test) |
| Giant module | > 500 lines with several responsibilities | split by responsibility, not by size; each part has one reason to change |
| Hidden global state | module-level mutable dicts, singletons, lazy globals set by functions | pass explicitly or own it in one object with a clear lifetime |
| Import-time side effects | model loading, file IO, logging config at import | move into functions called by entry points |

## Class level

| Smell | Detect | Usual fix |
|---|---|---|
| God class | > 300 lines, many unrelated methods, many attributes | extract collaborators by responsibility; keep the orchestrator thin |
| Copy-subclass | class duplicated and slightly edited instead of parametrised | one class with a parameter or a small strategy object |
| Speculative abstraction | ABC, registry or factory with one implementation | replace with the concrete class |
| Data bag of dicts | `dict[str, Any]` passed through many layers with string keys | `@dataclass` (or TypedDict at JSON boundaries) |
| Class that should be a function | class with `__init__` + one method and no state reuse | plain function |
| Alias class names | `NewName = OldName` at module end | rename callers, delete alias |

## Function level

| Smell | Detect | Usual fix |
|---|---|---|
| Long function | > 60 lines, mixed abstraction levels | extract well-named steps; keep the top-level readable as a story |
| Deep nesting | nesting ≥ 4 | guard clauses, early return, extract the inner loop body |
| Too many parameters | ≥ 6, often threaded unchanged through layers | config dataclass created once at the edge |
| Flag arguments | `def f(x, use_new=True)` choosing between two behaviours | two functions, or delete the unused branch |
| Sync/async twins | same body with and without `async` | keep one; derive the other with a thin adapter only if both are really needed |
| Defensive noise | try/except that swallows, repeated None checks inside trusted code | validate at the boundary once; let internal errors raise |

## Python specifics worth checking

- `try: import x except ImportError:` fallbacks that keep an old module path alive.
- `__init__.py` re-exporting moved names "for compatibility".
- `sys.path.insert(...)` hacks in scripts (they hide a package layout problem).
- String references to dotted paths: `importlib.import_module("…")`, Hydra/YAML `_target_`,
  `entry_points` in `pyproject.toml`/`setup.cfg`, `python -m pkg.mod` in shell scripts and docs.
- PyTorch: renaming `nn.Module` attributes changes `state_dict` keys. Moving a class changes
  the pickle path in full-model checkpoints. Both break saved files, so treat them as external
  contracts unless the user says the files can be regenerated.

## Small frontend pages

- The same JS/CSS/HTML copied into two folders. Keep one and serve it from one place.
- One giant inline `<script>`. Split it into ES modules by responsibility (api, state, render).
- Duplicated `fetch` wrappers and DOM building code. Use one helper.
- Dead CSS selectors, unused functions, `console.log` and `debugger` left in.
- Do not introduce a framework or build step for a small page.
