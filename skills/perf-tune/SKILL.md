---
name: perf-tune
description: Measurement-driven Python performance tuning - define a metric and workload, take a baseline, profile to find the real bottleneck, then apply one proven change at a time (algorithm, data structure, caching, vectorization, I/O and concurrency, PyTorch, compiled code, startup time) and keep it only if it beats measurement noise without changing behaviour. Use when the user asks to make Python code faster, reduce latency, memory or startup time, or find out why something is slow.
---

# Performance tuning

Make a working program faster **without changing what it does**. The order is always:
measure, find the bottleneck, change one thing, measure again. Guessing which code is slow is
usually wrong, and a rewrite of the wrong function gains nothing.

Run this after structural cleanup (`clean-arch`) when both are needed: profiling a codebase with
parallel implementations of the same thing points at code that is about to be deleted.

## Rules

1. **Measure before and after.** No optimization without a baseline number from this machine and a
   profile that shows where the time goes. Intuition proposes hypotheses; measurements decide.
2. **One change at a time.** Run the behaviour check and the benchmark after each change. Keep it
   only when the gain is clearly larger than run-to-run noise (and at least the threshold agreed
   in phase 0). Otherwise revert it. A change that "should" help but does not is deleted.
3. **Behaviour is preserved.** Same outputs on the golden inputs, same exceptions at public
   boundaries, same side effects. Anything that trades accuracy, ordering or determinism for speed
   (fp16/bf16, approximate algorithms, dropping validation, parallel reordering, stale caches) is a
   behaviour change: name it in the plan and get explicit approval.
4. **Cheapest, safest fix first.** Follow the ladder in `references/techniques.md`: do less work,
   better algorithm or data structure, built-ins, caching, vectorization, I/O and concurrency,
   compiled code. Stop as soon as the target is met.
5. **Amdahl's law.** A change can save at most the share of total time its code takes. Skip
   candidates under ~5% of the total unless they are trivial and safe.
6. **No leftovers.** Remove every temporary decorator (`@profile`), timing print and benchmark
   scratch file before finishing. No feature flags or `fast_`/`_old` twin implementations: pick
   one. Profile output goes to `.clean-arch/perf/` (local only, may contain paths), never into git.
7. **New dependencies, native builds and interpreter upgrades are the user's decision.** Numba,
   Cython, mypyc, Rust extensions, Polars, uvloop, orjson, a newer Python or the free-threaded
   build all change install and deployment. Propose them with the measured gain; do not add them
   silently.
8. **Do not commit.** Leave changes in the working tree, as in the other skills.

## Phases

### 0. Goal and workload

Write down, in `.clean-arch/perf.md`:

- **Metric**: wall-clock latency (p50/p95), throughput, CPU time, peak memory, startup time, or
  GPU utilisation. Different metrics need different tools (`references/profiling.md`).
- **Target**: "p95 under 200 ms", "2x throughput", "fits in 8 GB". Without one, ask the user, or
  define "stop when the top candidate gives under 5%".
- **Workload**: a representative, repeatable input, large enough that the run takes at least
  hundreds of milliseconds. A toy input profiles the wrong thing. Note cold versus warm
  (first request, empty caches, JIT or `torch.compile` warm-up).
- **Environment**: Python version, key package versions, CPU/GPU, thread and worker counts. Results
  only compare within one environment.
- **Behaviour check**: the existing tests, plus a golden-output comparison for the workload when
  tests are thin (outputs saved before any change; floats compared with an agreed tolerance).

### 1. Baseline

Run the workload unprofiled at least 5 times (3 if each run takes minutes) after one warm-up run.
Record median and spread. If the spread is above ~10% of the median, fix the noise first (close
other load, fix input, disable GC around the timed region) before trusting any comparison.

### 2. Locate

Pick the tool from the question, not from habit (table in `references/profiling.md`). Go broad,
then narrow: whole-program profile, then the top function, then its lines. Classify the
bottleneck before choosing a fix:

| Where the time goes | Typical cause | Look at |
|---|---|---|
| Python bytecode in your functions | loops, repeated work, bad algorithm | algorithm, built-ins, caching, vectorize |
| Native library calls (NumPy, pandas, torch) | many small calls, copies, wrong dtype or layout | batching, vectorization, dtype, avoiding copies |
| Waiting (network, disk, subprocess, locks) | sequential I/O, small pools, lock contention | concurrency, connection reuse, batching |
| Memory allocation and GC | millions of small objects, copies, retained references | generators, slots, arrays, chunking |
| Import and initialisation | heavy top-level imports on the CLI path | `-X importtime`, deferred imports |
| GPU idle | data loading, host-device syncs, small kernels | `DataLoader`, `.item()` in loops, `torch.compile` |

Verify surprising profile results with a second tool or a direct `timeit` of the suspect. When
the hot frames are inside a third-party library, read its section in `references/libraries.md`
before looking for a rewrite: the usual fix is how the library is called (bulk API, reused
object, array layout, thread count), not replacing it.

### 3. Plan

For each candidate, in order of (share of total time) x (ease and safety), write: evidence
(`file:line` and the profile number), the change, the expected gain bounded by Amdahl, the risk
and whether it changes behaviour. Put the plan in `.clean-arch/perf.md`. Show the user the top
candidates and get a go-ahead before editing: through `clean_arch_review` when the plan has
several steps or touches public behaviour, or an explicit "go" in chat for a single local change.
Inside the `clean-arch` workflow, the approved `arch-plan` already covers this.

### 4. Apply

For every candidate: change, behaviour check, benchmark against the baseline under the same
conditions (alternate baseline and candidate runs when the machine is noisy), keep or revert.
Record each result as a row: change, before, after, kept or reverted. A one-line comment that
states the constraint is enough for non-obvious fast code (`# hot path: called per row, keep
O(1)`); do not narrate the history (see `comment-hygiene`).

### 5. Verify and report

Run the full tests and the final end-to-end benchmark against the phase 1 baseline, then
`clean-finish` on the diff (it flags forgotten debug output and temporary files). Report in the
user's language, at most one screen:

- the metric before and after, and whether the target was met;
- the table of changes kept, with their individual gains, and the ones reverted;
- behaviour trade-offs that were approved;
- what remains slow and which larger options exist (compiled code, a different library,
  architecture change), with the measured share of time each would address.

If the target is not reachable with safe changes, say so with numbers and stop rather than adding
risky complexity.

## When not to optimize

- The code is not on a measured hot path, or runs once and takes seconds.
- Readability would suffer for under ~10% gain on code that is not the top bottleneck.
- The real problem is design (a call per row to a remote service, loading the whole dataset to use
  one column). Fix that in the architecture plan; it beats any micro-optimization.

## Supporting material

- `references/profiling.md`: which profiler for which question, commands, and how to benchmark
  without fooling yourself.
- `references/techniques.md`: the optimization ladder with when each technique pays off, its
  pitfalls, and the micro-optimizations that are not worth doing.
- `references/libraries.md`: notes for NumPy, PyTorch, Shapely, pyproj, scikit-learn, laspy/LASzip,
  OpenCV, protobuf and POT, plus cross-library traps (thread oversubscription, array layout and
  dtype at boundaries, float32 with large coordinates). Read the sections for the libraries that
  appear in the profile.
