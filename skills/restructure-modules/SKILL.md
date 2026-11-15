---
name: restructure-modules
description: Safe, complete module/package/class restructuring in Python - move, rename, merge duplicates, split modules, collapse parallel versions, break import cycles - updating every caller in the same step with no compatibility aliases left behind. Use when executing an approved restructuring plan step.
---

# Restructuring modules, packages and classes

Every operation follows the same loop:

1. **Find all references before changing anything.** Text search is the source of truth, and
   the analysis tools are a cross-check. For a module `pkg/sub/mod.py` and a symbol `Thing`:
   ```bash
   rg -n "pkg\.sub\.mod|pkg/sub/mod|from pkg\.sub import mod|\bThing\b" \
      --glob '!**/.clean-arch/**'
   ```
   Cover Python imports, relative imports (`from .mod import`), and strings
   (`importlib.import_module`, `_target_:` in YAML/Hydra, `entry_points` and `scripts` in
   `pyproject.toml`/`setup.cfg`). Also cover shell scripts (`python -m pkg.sub.mod`),
   Dockerfiles, CI files, notebooks (`*.ipynb`), docs and tests, mocks (`patch("pkg.sub.mod.X")`)
   and frontend files that call backend routes. `clean_arch_facts` with `command: importers`
   and `target: pkg.sub.mod` lists the imports and the text mentions in one pass; use it as
   the checklist and `rg` for symbols inside modules.
2. **Make the change and update every reference in the same step.**
3. **Delete the old location.** Do not leave `from new import *`, `Old = New`, a forwarding
   function, a `try/except ImportError` fallback, or a re-export in `__init__.py` kept "for
   compatibility". Do not keep `_old`, `_bak` or `_v1` copies. Git history is the backup.
4. **Verify.** Run the step's command from the plan, then:
   - `python -m compileall -q <changed dirs>`;
   - `clean_arch_facts` must not show new unresolved imports or new cycles;
   - the `rg` search from step 1 for the old name must return nothing (except changelogs and
     the plan itself).

If a reference sits in an external contract listed in the plan (published API, saved files,
HTTP route), stop and handle it the way the plan says. Never decide that on your own.

## Operations

### Collapse parallel versions / merge duplicates
1. Diff the copies (`diff -u`, or `git diff --no-index`).
2. Pick the survivor: the copy with more callers, tests and recent commits, or the one the
   plan names.
3. Port only differences that are deliberate behaviour (bug fixes, features). Drop
   differences that are drift (debug prints, renamed locals, dead branches). If you are not
   sure, ask.
4. Point all callers at the survivor, delete the other copies, and delete their tests or
   move the useful cases into the survivor's tests.

### Move or rename a module
- Use `git mv` so history follows the file.
- Fix imports inside the moved module too, because relative imports change meaning.
- Update `__init__.py` files only to expose the package's real public API, never to shadow
  the old path.

### Rename a symbol
- Rename definition and all uses in one step. Include keyword arguments at call sites,
  `__all__`, docstrings, logs that grep scripts depend on, and test names.

### Split a module
- Split by responsibility (reason to change), not by line count. Name each new module after
  what it owns, never `utils2`, `helpers` or `misc`.
- Callers import from the new module that owns the symbol. The old module disappears; it
  does not become a re-export hub.

### Break an import cycle
In order of preference:
1. Move the shared piece (types, constants, small pure functions) into a lower module that
   both sides import.
2. Merge two modules that are really one concept.
3. Move the dependency to the caller: pass the object or function in instead of importing it.
4. Only if there are two or more real implementations, introduce a `Protocol` in the lower
   layer.

Function-local imports and `TYPE_CHECKING` guards hide a cycle rather than fixing it.
Use them only for type hints.

### Extract a class / slim a god class
- Group methods and attributes by which data they use; each cohesive group becomes a
  collaborator with a name from the domain.
- The original class keeps orchestration and holds collaborators as attributes; callers that
  used extracted behaviour call the collaborator directly if that reads better.
- Do not create base classes to share code between two copy-subclasses. Merge them into one
  class with a parameter or a small strategy.

### Remove a pass-through layer
- Inline the forwarding functions into callers (or point callers at the real target), then
  delete the layer.

## Python pitfalls

- **Pickles and checkpoints.** A full-model `torch.save(model)` and other pickles store the
  class's import path. A `state_dict` stores attribute names. Renaming either breaks saved
  files. Treat them as external contracts unless the user confirms the files can be
  regenerated or converted.
- **Mocks.** `patch("a.b.C")` patches where the name is looked up. After a move, patch the
  new lookup location.
- **Import order.** Moving module-level code can change import-time side effects (registries
  filled on import, logging config). Check the registries still fill.
- **Namespace and path hacks.** If scripts use `sys.path.insert`, prefer fixing them to run as
  `python -m pkg.script` from the repository root. Note this in the plan first.

## Frontend pages

- Keep one copy of each static file and serve it from one place. Update the server's static
  path and every HTML `src`/`href`.
- When a backend route moves, update the `fetch` URLs in the same step.
