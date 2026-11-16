# Optimization ladder

Work down the list and stop when the target is met. Earlier rungs are cheaper, safer and often
bigger. Numbers quoted are from published benchmarks and vary by machine; use them to rank ideas,
and measure your own code.

## 1. Do less work

- Hoist invariants out of loops; compute once, reuse.
- Exit early (`any`/`all`, `return` on first match); filter before the expensive step.
- Avoid repeated parsing, reading or serializing of the same data; read a file once.
- Batch: one call with 1000 items instead of 1000 calls (database, HTTP, model, `subprocess`).
- Fix the query shape: one request per row to a service or database is a design problem, not a
  tuning problem.

## 2. Algorithm and data structure

Usually the largest win for the least code.

| Smell | Replace with |
|---|---|
| `x in some_list` inside a loop | build a `set` or `dict` once (list scan is O(n), set lookup O(1)); one-off lookups are not worth converting |
| `list.index`, nested loops over two lists | `dict` from key to value, or sort and `bisect` / merge |
| `list.pop(0)` / `insert(0, ...)` | `collections.deque` |
| repeated `sorted(...)` or `min` of a growing list | `heapq`, or sort once |
| `s += piece` in a loop | collect in a list, `"".join(parts)` |
| counting with a manual dict | `collections.Counter`, `defaultdict` |
| recomputing neighbours or prefixes | precompute an index or prefix sums |

Sets cost more to build than a list; if you insert more than you query, a list can win.

## 3. Built-ins and the standard library

Per-item work done in C beats the same loop in Python: `sum`, `min`, `max`, `sorted(key=...)`,
`str.join`, `Counter(iterable)`, `itertools`, `zip`/`enumerate`, comprehensions over `append` loops
(about 1.5x). It is the C push-down that helps, not the standard library label: wrapping a Python
callback in `any()` or `map` can be slower, so measure.

## 4. Caching

- `functools.cache` / `lru_cache(maxsize=N)` for pure functions of hashable arguments that are
  called repeatedly with the same inputs. Prefer a bounded `lru_cache` for open-ended inputs.
- Correct only if the result depends solely on the arguments. A function reading files, globals,
  time or mutable objects returns stale answers.
- Do not decorate instance methods without thought: the cache keeps `self` alive. Use
  `cached_property` for per-instance values, or cache a module-level function.
- Define invalidation (or why none is needed) in one comment.

## 5. Memory shape

- Stream with generators when you iterate once; a list can be a little faster but holds
  everything in memory.
- Process large files and tables in chunks.
- `@dataclass(slots=True)` or `__slots__` for millions of small objects with fixed fields: it saves
  memory and construction time. Attribute access is not reliably faster; measure.
- Numeric data in `array`, `numpy` or `memoryview` instead of lists of Python numbers.
- Avoid copies: slices of lists copy, `memoryview`/NumPy views do not; avoid `list(x)` round trips.

## 6. Vectorize

- NumPy: whole-array operations, `np.where`/`np.select` for branches, broadcasting; no Python loop
  over elements. Beware huge temporaries (chunk the work).
- pandas: never `iterrows` or `apply(axis=1)` for arithmetic (orders of magnitude slower than column
  operations); use column expressions, `groupby`, `merge`, `map`. `itertuples` only as a last resort.
- Row-to-row dependencies that cannot be vectorized: Numba (see rung 9) or a plain loop in a
  compiled helper.
- Large or repeated pipelines: Polars with the lazy API, native expressions (avoid `.apply`),
  column selection, smallest numeric dtypes, categoricals, Parquet. DuckDB for SQL-shaped work on
  files. Pandas stays fine for small data and interactive work, so a migration needs measured gain.
- Pick compact dtypes (`float32`, `int32`, categoricals) when precision allows; that is a behaviour
  decision for floats.

## 7. I/O and concurrency

Choose by the bottleneck found in phase 2:

| Work | Use |
|---|---|
| Many concurrent network or disk waits | `asyncio` (thousands of in-flight), or a thread pool (tens, blocking libraries) |
| Blocking library, moderate concurrency | `ThreadPoolExecutor`; also fine for C code that releases the GIL (hashing, compression, many NumPy ops) |
| Pure-Python CPU work | `ProcessPoolExecutor` / `multiprocessing` (pay for pickling and start-up; chunk the tasks) |
| Multi-threaded CPU-bound Python | free-threaded Python 3.14+ (about 2-3x on 4+ threads, 5-10% single-thread cost); check dependencies first |

Pitfalls that erase the gain:

- Library defaults cap concurrency: `requests.Session` pool of 10, `aiohttp` 100 connections,
  `httpx` 100. Set pool size to the intended concurrency.
- Reuse one client or session for all requests; creating one per call discards connection reuse
  (and in `httpx` rebuilds the TLS context each time).
- Bound `asyncio.gather` with a `Semaphore`; unbounded gather opens everything at once.
- Processes for tiny tasks are slower than sequential: IPC and start-up dominate.
- Concurrency changes ordering, error handling and shared-state safety: a behaviour change to
  review, not a free speedup.
- Cheap extras on I/O services: `uvloop` (Linux/macOS, about 10-30% less event-loop overhead),
  `orjson` (2-5x faster JSON, stricter than `json`: check NaN and large integers), HTTP/2 to
  multiplex over one connection.

## 8. PyTorch and GPU workloads

Check GPU utilisation and where the profiler shows idle gaps before touching the model.

- Inference: `model.eval()` plus `torch.inference_mode()` (use `no_grad` only where inference mode
  does not work).
- `torch.compile(model)`; `mode="reduce-overhead"` (CUDA graphs) helps small batches with
  launch overhead. Needs warm-up, can recompile on changing shapes, and not every model compiles
  without graph breaks: measure end to end.
- Mixed precision with `torch.autocast` (bf16 on Ampere and newer, fp16 with a `GradScaler` for
  training). It changes numerics: compare task metrics, not just speed, and get approval.
  `torch.set_float32_matmul_precision("high")` (TF32) is a smaller version of the same trade.
- Data loading: `DataLoader(num_workers>0, pin_memory=True, persistent_workers=True)` and
  `.to(device, non_blocking=True)`. Increase workers until throughput plateaus; `0` can win when
  the data is in memory and transforms are cheap. Do not call `tensor.pin_memory()` by hand then
  `.to(non_blocking=True)`.
- Host-device syncs inside loops: `.item()`, `.cpu()`, `.numpy()`, `print(tensor)`, Python `if` on a
  GPU tensor all stall the pipeline. Accumulate on the GPU, sync once.
- Batch size and shapes: larger batches raise throughput until memory or latency limits; sizes that
  are multiples of 8 map to tensor cores.
- Fused pointwise ops come from `torch.compile`; avoid hand-written chains of small elementwise ops
  on large tensors.
- Free tensors you do not need (`del`, `.detach()` in logging) before blaming the allocator.

## 9. Compiled code

Only for a measured CPU-bound hot spot that rungs 1-8 did not fix. All of these add build,
packaging or deployment cost, so they need user approval (rule 7).

| Option | Fits | Caveats |
|---|---|---|
| Numba `@njit` | numeric loops over arrays, no objects | only a Python subset in nopython mode; JIT warm-up of 0.5-2 s per function per process; `cache=True` helps |
| Cython | typed numeric code, wrapping C libraries | `.pyx` files, a C toolchain, slow edit-build loop |
| mypyc | already fully type-annotated, non-numeric code (parsers, tokenizers): 2-5x | strict typing needed; some dynamic patterns unsupported |
| Rust with PyO3 / maturin | substantial new native code | learning curve; call and conversion cost per crossing |

Keep the whole hot loop on the native side and pass arrays or batches. Calling a tiny compiled
function from a Python loop pays the call and conversion cost every time and can be slower. If the
build fails for some users, the project needs one decision (compiled only, or pure Python only),
not two silent copies.

## 10. Interpreter and runtime

An environment change, so propose it rather than doing it:

- Python 3.11 and later are much faster than 3.10 and older (specializing interpreter); 3.14 is
  the fastest CPython so far on typical benchmarks.
- The experimental JIT (3.13+) gains were small (a few percent on 3.14 and early 3.15); do not
  count on it.
- The free-threaded build helps only multi-threaded CPU-bound code and needs compatible extensions.
- PGO+LTO builds give about 10%; pyenv or distro builds may already include them.
- Check that dependencies (NumPy, torch, pandas) support the target version first.

## 11. Startup and import time

For CLIs, hooks and short-lived scripts.

- `python -X importtime -c "import pkg" 2> imports.txt`, find the slow cumulative imports.
- Move rarely used heavy imports (`pandas`, `torch`, `matplotlib`, SDK clients) inside the
  functions or behind a module `__getattr__` in `__init__.py`; 3.15 adds explicit `lazy import`.
- Moving an import moves its failure and its side effects (plugin registration, logging setup)
  to first use. Keep such imports eager, and run each command once after the change.
- Avoid work at import time: no network, no file scans, no model loading in module scope.
- Measure startup plus first use; the cost may move rather than disappear.

## Micro-optimizations: usually not worth it

Apply only inside a proven hot loop, and only when the benchmark shows it:

- binding attributes or methods to locals (`append = out.append`): about 1.2x on the tightest
  loops; hurts readability elsewhere
- `x * x` over `x ** 2`, f-strings over `%`/`format`, `is None` over `== None`
- list comprehension over a generator when feeding `join` (about 1.2x), and the opposite when you
  stop early or memory matters
- `try/except` over `in` checks when misses are rare

Do not trade clarity for these in code that is not the top of the profile.

## Common mistakes

- Optimizing before profiling, or profiling a toy input.
- Starting with concurrency or native code when a data structure change would do.
- Unbounded caches; caches keyed on part of the real inputs; caching impure functions.
- A benchmark that includes setup or measures a cache hit.
- Comparing runs from different machines, Python versions or load conditions.
- Leaving profilers, timing code and `@profile` in the source.
- Treating one speed-up as permanent: when the workload grows, re-measure.
