# Profiling and benchmarking

Profilers locate cost; benchmarks prove a change helped. Use both, and use the tool that
answers the question you actually have.

## Which tool for which question

| Question | Tool | Notes |
|---|---|---|
| Which functions use CPU, with exact call counts? | `cProfile` + `pstats` | Standard library. Tracing adds overhead and distorts call-heavy code. |
| Where does wall-clock time go in a request or script, including waiting? | `pyinstrument` | Sampling call tree, readable. Elapsed time is not CPU time. |
| What is a running process doing, without restarting it? | `py-spy` | External sampler. May need permissions to attach. |
| Which lines in a known hot function are slow? | `line_profiler` (`kernprof`) | Needs a temporary `@profile` decorator; remove it afterwards. |
| Python vs native vs memory vs copying, per line | Scalene | The command line changed across versions; check `scalene --help`. |
| Who allocates memory, what is retained? | Memray | Linux and macOS only. |
| Python-level allocations only | `tracemalloc` | Misses native, GPU and mmap memory. |
| Did a small snippet get faster? | `timeit` | Per-snippet only. |
| Is a difference reproducible across processes? | `pyperf` | Many processes, warm-up, statistics. |
| Why is startup slow? | `python -X importtime` | Shows cumulative import time per module. |
| PyTorch operators and GPU kernels | `torch.profiler` | Also check GPU utilisation outside Python (`nvidia-smi`). |

Python 3.15 adds a standard `profiling.sampling` sampler and `profiling.tracing` (cProfile).

## Commands

```bash
# whole program, exact counts; inspect with: python -m pstats out.prof
python -m cProfile -o .clean-arch/perf/out.prof -m pkg.module --args

# sampled call tree, includes time spent waiting
pyinstrument -r html -m pkg.module

# running process; "record" writes a flame graph, "dump" prints current stacks
py-spy top --pid <pid>
py-spy record -o .clean-arch/perf/flame.svg --pid <pid>
py-spy record -o .clean-arch/perf/flame.svg -- python -m pkg.module

# lines in a hot function (add @profile temporarily)
kernprof -l -v script.py

# memory
python -X tracemalloc=25 -m pkg.module
memray run -o .clean-arch/perf/mem.bin script.py && memray flamegraph .clean-arch/perf/mem.bin

# snippets and imports
python -m timeit -s "setup" "statement"
python -X importtime -c "import pkg" 2> .clean-arch/perf/imports.txt
```

Add `--native` to `py-spy` when the time may be inside C extensions. Profile with the same
Python and package versions that production uses.

## Reading a profile

- Sort by cumulative time to find the call path, by own time (tottime) to find the leaf that
  burns CPU.
- A function with huge call counts and tiny per-call cost is a call-count problem: hoist, batch
  or vectorize, not micro-tune.
- Time inside `numpy`/`torch`/`pandas` frames called from a Python loop means many small calls;
  time inside one big native call means the library is already doing the work.
- Mostly idle or `select`/`recv`/`sleep` frames mean waiting: use concurrency or batching, not a
  faster algorithm.
- Profilers add overhead. Always compare against the unprofiled baseline, and re-measure without
  the profiler after each change.

## Benchmarking without fooling yourself

- **Same conditions every time**: same machine, input, Python version, power state; nothing else
  heavy running. Do not compare numbers from different machines or Python versions.
- **Warm up**: discard the first run (imports, caches, JIT, `torch.compile`, CUDA context). Report
  cold start separately when it matters.
- **Repeat and use robust statistics**: at least 5 runs; report median and spread (min or IQR),
  not a single run and not the mean.
- **Measure noise first**: run the unchanged code several times. A "gain" inside that band is noise.
- **Interleave** baseline and candidate on a noisy machine, so drift hits both equally.
- **Control the garbage collector** in micro-benchmarks (`gc.collect()` before, `gc.disable()`
  during), so a collection does not land in only some runs.
- **Time the right thing**: do not include setup, fixtures or I/O you are not changing. Use the
  result (assert on it) so nothing is optimized away.
- **Beware caches**: a memoized function measured twice measures the cache hit. Clear it between
  runs when the cold path matters.
- **GPU work is asynchronous**: call `torch.cuda.synchronize()` before reading the clock, or use
  `torch.utils.benchmark`.
- **Concurrency needs a realistic load**: a benchmark with one request says nothing about contention
  and pool limits.
- Keep benchmarks out of the normal test run unless the user asks for a regression gate. A CI
  gate needs a threshold above measured noise, medians, and baseline and candidate run in the same
  job; otherwise it fails on noise and people stop trusting it.
