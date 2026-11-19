# Profiling, Memory Analysis and Visual Flame Graphs

Profilers locate where time and memory go; unprofiled benchmarks prove a change helped. Prefer
`clean_arch_perf` (`env`, `profile`, `bench`) first — it automatically uses installed open-source
profilers and renders **self-contained `.svg` flame graphs and comparison charts** that display in
IDEs, `clean_arch_review`, GitHub and CodeHub without external viewers.

## Automated tool chain in `clean_arch_perf`

| Need | `clean_arch_perf` call | Underlying engine (best available → stdlib fallback) | Visual output (`.clean-arch/perf/`) |
|---|---|---|---|
| CPU & wall-clock call paths | `action="profile", mode="cpu"` (or `"all"`) | `py-spy` (250 Hz native-aware) → `pyinstrument` (wall-clock tree) → `cProfile` (`pstats` DAG) | `profile-<name>-cpu.svg` (icicle flame graph) |
| Peak physical RAM + Python heap | `action="profile", mode="memory"` (or `"all"`) | OS Peak RSS (`ru_maxrss` / Win32 Job Object) + `memray` (POSIX) + `tracemalloc` (25-frame stacks) + `torch.cuda` | `profile-<name>-memory.svg` (allocation flame graph) |
| CLI / package startup latency | `action="profile", mode="import"` | `python -X importtime` post-order tree builder | `profile-<name>-import.svg` (import waterfall/flame SVG) |
| Before/after speed & Peak RSS | `action="bench", compare="baseline"` | Unprofiled subprocess runner with warm-up, medians, IQR spread & OS Peak RSS (`peak_mb`) | `bench-<cand>-vs-<base>.svg` (bar + whisker chart) |

## When to use additional open-source profilers directly

When the automated SVG points to a dense C/native hotspot or an `OS Peak RSS >> traced Python heap`
gap, reach for these lightweight open-source tools (probed by `clean_arch_perf env`):

| Question | Open-source tool | Install & command |
|---|---|---|
| Attach to an already-running server/worker without restarting, or inspect C/C++ extension frames (`--native`) | **`py-spy`** (Rust, Windows/Linux/macOS) | `pip install py-spy`<br>`py-spy record --native -o .clean-arch/perf/native-flame.svg --pid <pid>` |
|Readable wall-clock tree in terminal including async / I/O waits | **`pyinstrument`** (pure Python + C ext, cross-platform) | `pip install pyinstrument`<br>`pyinstrument -m pkg.module --args` |
| Native C/C++/Rust memory high-watermark, temporary churn & leaks (Linux/macOS) | **`memray`** (Bloomberg, Linux/macOS) | `pip install memray`<br>`memray run -o .clean-arch/perf/mem.bin -m pkg.module && memray summary .clean-arch/perf/mem.bin` |
| Per-line split of **Python CPU vs Native C CPU vs RAM MB vs Python↔C Copy MB/s** (ideal for NumPy/Shapely/OpenCV copies) | **`scalene`** (Windows/Linux/macOS) | `pip install scalene`<br>`scalene --cli --reduced-profile script.py` |
| Exact line-by-line timings inside one known hot Python function | **`line_profiler`** (`kernprof`) | `pip install line_profiler` (add `@profile` temporarily, remove before finishing)<br>`kernprof -l -v script.py` |
| PyTorch CPU/CUDA operator timeline & kernel gaps | **`torch.profiler`** | Built into PyTorch; export Chrome trace `.clean-arch/perf/trace.json` and check `nvidia-smi` |

## Reading the generated SVG flame graphs

- **Width = cost.** In `profile-*-cpu.svg`, horizontal bar width is proportional to total time on
  stack; look for **wide plateaus** near the bottom of a call chain, not deep thin needles.
- **Colour = layer:**
  - **Amber / coral (`Project code`)**: your repository's own `.py` files — algorithm, loop or
    data-structure fixes apply directly.
  - **Slate blue (`Library / stdlib`)**: third-party Python frames — check how you call the
    library (batch vs per-item, object reuse in `references/libraries.md`).
  - **Teal (`C / native`)**: C extensions / built-ins — many tiny calls under an amber parent mean
    a Python loop calling C per item; one wide teal block means a single bulk native call.
- **Memory gap (`OS Peak RSS` vs `tracemalloc` Python heap):**
  - `tracemalloc` only sees Python objects (`list`, `dict`, instances). NumPy arrays, Shapely
    GEOS geometries, `laspy` point buffers, OpenCV `Mat` and PyTorch tensors allocate directly via
    C/C++/Rust allocators and show up in **OS Peak RSS (`peak_mb`)**, not `tracemalloc`.
  - When `OS Peak RSS` is high while `tracemalloc` is tiny, look for large array temporaries
    (`a * b + c`), non-contiguous copies (`astype`, `np.append` in loops), whole-file reads
    (`laspy.read`), or `N x M` distance matrices (`torch.cdist`, `ot.dist`).

## Benchmarking without fooling yourself

`clean_arch_perf bench` handles warm-up, repeated runs, median/spread noise bands, Peak RSS
tracking and baseline comparison charts. Keep these rules in mind:

- **In-process sub-timings (`PERF_METRIC`)**: `wall` includes Python startup and imports. When
  optimizing an inner stage, print `PERF_METRIC stage_name=<seconds>` (measured with
  `time.perf_counter()` after loading/warm-up) or `PERF_METRIC gpu_peak_mb=<mb>`; `bench` tracks
  and plots every metric alongside `wall` and `peak_mb`.
- **Same conditions every time**: same machine, power state, Python interpreter and thread env
  vars (`OMP_NUM_THREADS`, etc.).
- **Noise first**: if `spread` exceeds ~10%, quiet background load, pin input seeds, or increase
  `runs` before comparing.
- **GPU is asynchronous**: call `torch.cuda.synchronize()` before stopping timers!
- **Never benchmark with a profiler attached**: tracing (`cProfile`, `tracemalloc`, `Scalene`)
  adds 1.3x–5x overhead and skews Python-heavy code relative to C code. Profile in Phase 2 to
  find the bottleneck; always verify in Phase 4 with unprofiled `bench`.
