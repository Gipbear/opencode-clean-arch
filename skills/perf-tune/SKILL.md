---
name: perf-tune
description: Measurement-driven Python performance and memory tuning with open-source profilers and self-contained SVG flame/comparison charts - take a baseline (wall time + OS Peak RSS), profile CPU/memory/imports via py-spy, pyinstrument, memray or stdlib fallbacks, and keep only changes that beat noise. Use when making Python faster or leaner.
---

# Performance and memory tuning

Make a working program faster or leaner **without changing what it does**. The loop is always:
measure baseline (time + Peak RSS), profile to see where time and memory actually go (with flame
graphs), change one thing, measure again. Guessing without a profile is usually wrong.

Run this after structural cleanup (`clean-arch`) when both are needed: profiling a codebase with
parallel copies of the same module points at code that is about to be deleted.

## Rules

1. **Measure before and after (both time and memory).** No optimization without an unprofiled
   baseline on this machine (`wall` + `peak_mb` OS Peak RSS) and a real profile (`action:
   "profile"`) with flame-graph SVGs showing where CPU/wall time or memory allocations go.
2. **One change at a time.** Run the behaviour check and `clean_arch_perf` `bench` (`compare:
   "baseline"`) after each change. Keep it only when the gain exceeds run-to-run noise (and the
   agreed threshold). Revert anything "within noise" or slower.
3. **Behaviour is preserved.** Same outputs on golden inputs, same exceptions at public
   boundaries, same side effects. Anything trading accuracy, ordering or determinism for speed or
   RAM (fp16/bf16, approximate kNN/OT, dropping validation, parallel reordering, stale caches)
   needs explicit approval in the plan.
4. **Cheapest, safest fix first.** Follow `references/techniques.md`: do less work, better
   algorithm/data structure, built-ins, caching, memory layout/chunking, vectorization, I/O and
   concurrency, compiled code. Stop once the target is met.
5. **Amdahl's law.** Skip candidates under ~5% of total time/memory unless trivial and risk-free.
6. **No leftovers.** Remove temporary `@profile` decorators, timing prints and scratch scripts
   before finishing. Profile artefacts and SVGs live under `.clean-arch/perf/` (local only, never
   committed unless the user asks to copy a chart into docs).
7. **New dependencies, native builds and interpreter upgrades are the user's decision.** Even
   lightweight profilers (`py-spy`, `pyinstrument`, `memray`, `scalene`) are optional:
   `clean_arch_perf` uses them automatically when installed and falls back cleanly to stdlib
   `cProfile`, `tracemalloc`, `-X importtime` and OS Peak RSS when they are not. Mention optional
   profiler installs only if deeper C/native line-level attribution is needed.
8. **Do not commit.** Leave source changes uncommitted in the working tree.
9. **Learn from measured results only.** Query `lessons` before planning, and record reusable
   verified wins or measured rejections at the end.

## Tools

`clean_arch_perf` has five actions (without the plugin, run
`python ../clean-arch/scripts/perf_check.py --root <repo> <action>` relative to this skill):

| Action | Use it for |
|---|---|
| `env` | Probe Python version, library backends (protobuf `upb`, laspy `lazrs`, OpenMP runtimes, BLAS/torch/cv2 threads) **and installed open-source profilers** (`py-spy`, `pyinstrument`, `memray`, `scalene`). Pass `python` = project interpreter. |
| `bench` | Unprofiled repeated benchmark: warm-up, N runs, median & spread for `wall` time, **OS Peak RSS (`peak_mb`, Python + C/native buffers)**, and any `PERF_METRIC name=value` lines. Passing `compare: "<base>"` renders a self-contained comparison chart `.clean-arch/perf/bench-<name>-vs-<base>.svg`. |
| `profile` | Automated profiling + **self-contained SVG flame graphs** (`mode: "all" \| "cpu" \| "memory" \| "import"`). Uses `py-spy` or `pyinstrument` for low-overhead CPU/wall sampling when installed (stdlib `cProfile` fallback), `memray` + `tracemalloc` + OS Peak RSS (+ CUDA peak) for memory, and `-X importtime` for startup. Writes `.clean-arch/perf/profile-<name>-{cpu,memory,import}.svg`. |
| `scan` | Static AST scan for known slow patterns (`file:line` + pointer into `references/libraries.md`). Leads only — confirm in the flame graph before editing. |
| `lessons` | Search or extend the persistent store of verified optimization lessons (`~/.clean-arch/perf-lessons.md`). |

## Phases

### 0. Goal, workload and environment

Write `.clean-arch/perf.md` with:
- **Metric & target**: wall latency, throughput, **Peak RSS memory (`peak_mb`)**, GPU memory, or
  CLI startup time, plus a concrete target ("Peak RSS under 2 GB", "2x faster", or "stop when top
  candidate < 5%").
- **Workload**: representative, repeatable input taking at least hundreds of milliseconds so
  sampling and Peak RSS reflect real work rather than interpreter boot.
- **Environment & profilers**: run `clean_arch_perf` `env` with `python` set to the project's
  interpreter. A pure-Python protobuf backend, missing `lazrs`, or OpenMP oversubscription often
  explains the slowdown immediately.
- **Prior lessons**: query `clean_arch_perf` `lessons` for the libraries/symptoms involved.
- **Behaviour check**: existing tests plus golden-output verification on the workload.

### 1. Unprofiled baseline (time + Peak RSS)

Run `clean_arch_perf` `bench` with `name: "baseline"` (at least 5 runs, or 3 for multi-minute
workloads; 1 warm-up). Record both `wall` (plus any in-process `PERF_METRIC`) and `peak_mb`
median/spread in `.clean-arch/perf.md`. Fix noise > ~10% before trusting small diffs.

### 2. Locate with profilers and SVG flame graphs

1. Run `clean_arch_perf` `profile` with `name: "baseline"`, `python` = project interpreter, and
   `target` = the workload entry (e.g. `"-m pkg.job --input sample.las"`):
   - Use `mode: "all"` (default) to capture **both** `.clean-arch/perf/profile-baseline-cpu.svg`
     and `.clean-arch/perf/profile-baseline-memory.svg` (plus OS Peak RSS vs traced Python heap);
   - Use `mode: "import"` (`target: "-c \"import pkg\""`) when startup latency is the goal;
   - For deeper native line-by-line copy/memory attribution when `OS Peak RSS >> Python heap`, see
     `Scalene` / `Memray` / `line_profiler` commands in `references/profiling.md`.
2. Run `clean_arch_perf` `scan` to cross-reference hot functions in the flame graph against known
   library anti-patterns (`references/libraries.md`).
3. Embed the flame-graph SVGs directly in `.clean-arch/perf.md` using relative paths such as
   `![CPU flame graph](perf/profile-baseline-cpu.svg)` and
   `![Memory flame graph](perf/profile-baseline-memory.svg)` — they render inline in IDE Markdown
   previews and in `clean_arch_review`!
4. Classify the bottleneck before picking a technique:

| What the flame graph / memory report shows | Typical cause | Look at |
|---|---|---|
| Wide amber (`Project code`) bars in Python loops | O(n^2) lookup, per-item Python work | algorithm, built-ins, caching, vectorize |
| Many narrow C/library calls under a Python loop | per-item `Point`/`Transformer`/small NumPy calls | batch/vectorize API (`references/libraries.md`) |
| Wide single native frame (`numpy`, `scipy`, `ot`) | huge dense matrix, wrong dtype/contiguity, solver size | downsample/chunk, `float32`, `cKDTree(workers=-1)` |
| `OS Peak RSS >> traced Python heap` | big native C/C++/Rust arrays or copies | chunked streaming, `out=`/`in-place`, dtype hygiene |
| High retained Python heap in `tracemalloc` SVG | millions of Python objects/dicts kept alive | generators, `@dataclass(slots=True)`, arrays |
| Waiting frames (`select`, `recv`, `Lock`, `sleep`) | sequential I/O or lock contention | batching, connection reuse, `asyncio` / pool |
| Slow startup in `import` SVG | heavy top-level `torch`/`pandas`/SDK imports | lazy/function-local imports |

### 3. Plan and review

Rank candidates by `(measured share of time or memory) * (ease & safety)` in `.clean-arch/perf.md`
alongside the baseline flame graphs: evidence (`file:line` + profile % / MB), change, Amdahl-bounded
expected gain, and behaviour impact. Get approval via `clean_arch_review` on `.clean-arch/perf.md`
(so the user sees the flame graphs and plan together in the browser) when there are multiple steps
or trade-offs, or a quick "go" in chat for a single local fix.

### 4. Apply one by one and chart comparisons

For each candidate:
1. Apply the change and run the behaviour check;
2. Run `clean_arch_perf` `bench` with `name: "step1"` (etc.) and `compare: "baseline"` (or the
   last kept benchmark) — this checks noise bands for both speed and `peak_mb` and writes
   `.clean-arch/perf/bench-step1-vs-baseline.svg`;
3. Keep **only** when the target metric verdict is `"faster"` or `"lower"` (without unacceptable
   regression in the other); revert `"within noise"` or regressions.

### 5. Final verification, visual report and lessons

1. Run the full test suite, a final `bench` (`name: "final"`, `compare: "baseline"`) and, when
   helpful, a `profile` (`name: "final"`) so before/after SVGs sit side by side in
   `.clean-arch/perf.md`.
2. Run `clean-finish` on the diff to ensure zero stray `@profile`, debug prints or temp files.
3. Record reusable verified wins or measured rejections via `clean_arch_perf` `lessons` (see
   format below).
4. Reply in the user's language (at most one screen), embedding the final comparison SVG
   (`![Benchmark final vs baseline](<abs_or_rel_path>)`) and summarizing:
   - baseline vs final time and Peak RSS (`peak_mb`), and whether the target was met;
   - changes kept (with individual measured gains) and changes reverted;
   - where the flame-graph and comparison SVGs are saved (`.clean-arch/perf/`);
   - lessons added, approved trade-offs, and remaining bottlenecks.

## Lessons format

Shared across projects in `~/.clean-arch/perf-lessons.md` (`CLEAN_ARCH_LESSONS`). Record only
measured, project-agnostic entries (no paths or proprietary names; numbers required):

```text
## shapely: contains_xy on a prepared polygon beats Point + contains
- status: verified
- topics: shapely, point-in-polygon, vectorization
- symptom: 2M points tested against one 180-vertex polygon in a Python loop
- change: shapely.prepare(poly); shapely.contains_xy(poly, x, y) on coordinate arrays
- result: 41 s -> 0.9 s (45x), Peak RSS 1420 MB -> 310 MB, 2M points
- environment: python 3.11, shapely 2.0.4, GEOS 3.12, 8 cores
- caveats: identical results; needs shapely >= 2
```

## Supporting material

- `references/profiling.md`: profiler selection matrix (`py-spy`, `pyinstrument`, `Memray`,
  `Scalene`, `line_profiler`, `torch.profiler`), SVG interpretation, and rigorous benchmarking.
- `references/techniques.md`: the 11-rung optimization ladder and common traps.
- `references/libraries.md`: NumPy, PyTorch, Shapely, pyproj, scikit-learn, laspy/lazrs, OpenCV,
  protobuf and POT specifics.
