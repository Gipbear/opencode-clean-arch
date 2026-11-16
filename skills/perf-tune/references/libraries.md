# Library-specific notes

For projects built on NumPy, PyTorch, Shapely, pyproj, scikit-learn, laspy/LASzip, OpenCV,
protobuf and POT (point clouds, geometry, imagery, optimal transport). Read the sections for the
libraries that appear in the profile; skip the rest.

These notes come from library documentation, maintainers' benchmarks and issue threads. Numbers
depend on the machine, data and versions, so they rank ideas and do not promise gains. A few
entries are widely known practice rather than quoted benchmarks. Always confirm on the project's
own data with the loop in `SKILL.md`.

## Symptom to likely cause

| Symptom | Look first at |
|---|---|
| Python loop over points, rows, pixels or geometries dominates the profile | vectorize; per-library bulk APIs below |
| CPU usage far above the core count, or workers slower than a single process | thread oversubscription (BLAS, OpenMP, OpenCV, torch) |
| Memory spikes, or `MemoryError` on large clouds | N x N distance matrices, big temporaries, whole-file reads |
| Time inside `Point(...)`/`Transformer(...)`/`CRS(...)` constructors | objects created per item; create once, reuse |
| Time in `numpy.core` copies, `ascontiguousarray`, `astype` | array layout or dtype crossing a library boundary |
| `pytest`/DataLoader hangs after `fork` with OpenCV | OpenCV threads in forked workers |
| Slow protobuf (MB/s instead of hundreds of MB/s) | pure-Python backend, unpacked repeated fields, per-element access |
| POT call takes minutes, or prints `numItermax reached` | problem size (O(n^2) memory), regularization too small, wrong solver |

## Across all of them

1. **Thread budget.** BLAS (NumPy, SciPy, scikit-learn, CPU torch), OpenMP (scikit-learn, OpenCV,
   torch), joblib workers, `DataLoader` workers and thread pools all spawn threads. The total
   should be about the core count. Inside a worker pool, give each worker one thread:
   `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `cv2.setNumThreads(0)`,
   `torch.set_num_threads(1)`, or `threadpoolctl.threadpool_limits(1)` around the call. Check
   with a CPU monitor; high system time and more than 100% per core mean oversubscription.
2. **Array hygiene at library boundaries.** Convert once, at the boundary, not per call. Many
   native APIs want C-contiguous arrays of one dtype (`float64` for SciPy KD-trees, scikit-learn
   trees, POT `emd`; `float32` for most torch work) and silently copy otherwise, including
   reversed or sliced views (`img[..., ::-1]`, `a[:, 0]`). Use `np.ascontiguousarray(a, dtype=...)`
   where the API needs it, and check `a.flags["C_CONTIGUOUS"]` and `a.dtype` when a call is
   slower than expected.
3. **float32 and large coordinates.** Projected coordinates (UTM, local grids) are 1e5-1e7 m;
   `float32` keeps about 7 significant digits, so positions get decimetre-level errors. Subtract a
   per-tile origin before casting to `float32` and add it back at the end, or keep `float64` for
   coordinates and use `float32` only for features. This is a behaviour decision: get approval.
4. **Process in tiles and chunks end to end.** Read a chunk, project, filter, compute, write, with
   the same origin and grid for every tile (per-tile origins make seams at tile borders).
5. **Share read-only data.** Fork workers inherit large arrays without copying on Linux; passing
   arrays through `multiprocessing` arguments pickles them. Use shared memory or memory-mapped files
   for big arrays, and give workers file paths or tile ids instead of data.

## NumPy

- Remove Python loops over elements; use whole-array expressions, broadcasting, `np.where`,
  boolean masks and `np.searchsorted`.
- Every chained expression allocates temporaries (`a * b + c` makes two). On big arrays use
  in-place operators and `out=`; preallocate results instead of `np.append`/`np.concatenate` in a
  loop (quadratic); build lists and concatenate once.
- Reduce along the last axis for contiguous memory access; `einsum(..., optimize=True)` for
  contractions of three or more operands, with `out=` to avoid extra copies.
- Grouping and scatter: `np.add.at` and `np.unique(axis=0)` are slow on millions of rows. Pack
  integer keys (for example voxel indices into one `int64`), `argsort` once, then use
  `np.flatnonzero(np.diff(keys_sorted))` with `np.add.reduceat`, or `np.bincount(..., weights=...)`
  for sums and counts. Voxel downsampling with this approach runs about 2 million points per second.
- Top-k and thresholds: `np.partition`/`np.argpartition` instead of a full sort.
- Boolean masks and fancy indexing copy; compute the mask once and reuse it. Avoid chaining
  `a[mask1][mask2]`; combine masks.
- Mixed dtypes upcast silently (`float32` array with a `float64` array doubles the memory). Check
  result dtypes in hot paths.
- NumPy releases the GIL for many operations, so a thread pool over chunks can scale; NumPy does not
  parallelize elementwise operations itself.

## PyTorch (point clouds and geometry on GPU or CPU)

- Distances: `torch.cdist` of N x M points builds an N x M matrix (10^5 x 10^5 floats is 40 GB).
  Chunk the queries and keep only `topk` per chunk, or use a kNN library (PyTorch3D `knn_points`
  for batched 3D clouds with small K; FAISS or KeOps for large retrieval).
- Keep data on the device across steps; do the transfer once. `.cpu()`, `.numpy()`, `.item()` and
  Python branching on a tensor force a synchronization.
- `torch.from_numpy` shares memory on CPU (no copy); `tensor.numpy()` on GPU copies and syncs.
- Use `torch.inference_mode()` for inference loops, and batch point clouds rather than looping in
  Python over small ones. For variable-size clouds use padding with masks or indexed gather and
  `scatter_reduce`/`index_add_` instead of per-cloud loops.
- Time GPU code with `torch.cuda.synchronize()` or `torch.utils.benchmark`.
- Precision and `torch.compile` rules are in `references/techniques.md` section 8.

## Shapely

- Use the 2.x vectorized API: functions take arrays of geometries and run the loop in C. Do not
  loop over geometries in Python. Create geometries in bulk (`shapely.points(x, y)`,
  `shapely.linestrings`, `shapely.from_wkb`) and extract in bulk (`shapely.get_coordinates`,
  `shapely.get_parts`, with `return_index`).
- Many points against one polygon: `shapely.prepare(polygon)` then `shapely.contains_xy(polygon, x, y)`.
  It skips creating `Point` objects (creating a million points can take longer than the test), and a
  prepared geometry is several times faster again. Use `STRtree` only when you have many polygons or
  need a spatial filter; for one simple polygon it adds overhead.
- Many-to-many: `STRtree(geoms).query(other_geoms, predicate="intersects")` returns index pairs and
  evaluates the predicate on prepared geometries. `query_nearest(..., max_distance=...)` limits the
  search and is much faster than unbounded nearest. Trees on widely spaced multi-part geometries
  are inefficient; query the individual parts (`get_parts`) and map back by index.
- Geometry construction and destruction dominates many pipelines: avoid creating and discarding
  temporary geometries inside loops.
- Coordinate transforms: `shapely.transform` or `get_coordinates`/`set_coordinates` with an array
  function, not `shapely.ops.transform` per geometry (deprecated, calls the function per geometry).
- Combine many geometries with `shapely.union_all` (one call), not a Python loop of pairwise
  `union`. Validate once (`make_valid`), simplify before heavy overlay when
  the tolerance allows (a behaviour decision).
- Shapely functions release the GIL: partition a large array into chunks and process them in a
  thread pool. Do not share and mutate geometries across threads.
- Skip Python-level per-pixel containment tests when rasterizing polygons; rasterize with
  `cv2.fillPoly` or `rasterio.features.rasterize` instead.

## pyproj

- Create `Transformer` objects once and reuse them; creation is the expensive part (the pyproj docs
  show a repeated-call example at ~160 ms against ~6 microseconds for a reused transformer).
  Cache them by CRS pair (a module-level `functools.cache` function). Cache `CRS` objects too; do
  not rebuild from strings per call.
- Pass whole NumPy arrays: `x2, y2 = transformer.transform(x, y)`. Per-point calls are hundreds of
  times slower. Use `float64` arrays; chunk very large clouds to bound memory.
- Always pass `always_xy=True` to keep (x, y) / (lon, lat) order. A swapped axis order produces
  plausible-looking wrong numbers, not an error.
- Failed points come back as `inf`; check `np.isfinite` instead of assuming success (`errcheck=True`
  raises instead).
- `Transformer` and `CRS` are thread-safe since pyproj 3.1; share one across threads (arrays are
  processed with the GIL released). With older versions create one per thread.
- Transform 2D when Z does not need a datum change; transforming Z with a vertical datum can pull in
  grid files.
- Grid-shift transformations may try to download grids if network access is enabled; in an offline
  environment this shows up as long first-call latency (`PROJ_NETWORK=OFF`).
- For GeoDataFrames use `to_crs` (vectorized), not `apply` with `ops.transform`.

## scikit-learn

- Two separate thread pools: `n_jobs` (joblib) and native OpenMP/BLAS. Nesting them (for example
  `GridSearchCV(n_jobs=8)` over an OpenMP estimator) oversubscribes. The default joblib `loky`
  backend limits child threads; the `threading` backend does not. Cap with `threadpool_limits`.
- Services that call `predict` per request: `set_params(n_jobs=1)` or `threadpool_limits(1)`;
  threading overhead exceeds the work on small inputs.
- Nearest neighbours on large point clouds: SciPy `cKDTree(points).query(q, k=k, workers=-1)` is
  usually far faster than single-thread `sklearn.neighbors.KDTree`/`NearestNeighbors` (one lidar
  comparison measured 0.23 s against 37 s for k=5 on a large cloud). Build once and reuse the tree;
  pass C-contiguous `float64`; keep `balanced_tree=True`; shuffle input that is already sorted if
  the build is slow. Use `distance_upper_bound` when only close neighbours matter. KD-trees stop
  helping above about 20 dimensions: use brute force or an approximate index.
- sklearn trees: `leaf_size` changes speed a lot on real lidar data (the default may be poor;
  tune it); `query(..., dualtree=True)` helps for large query sets; the tree APIs cast to
  `float64`, so `float32` input does not speed them up.
- Memory-bounded distances: `pairwise_distances_chunked`, `pairwise_distances_argmin_min` instead
  of a full `pairwise_distances` matrix.
- `DBSCAN` stores the neighbourhood of every point; memory grows with `eps` and density. Downsample
  (voxel grid) first, or use a smaller `eps`, or `HDBSCAN`.
- `MiniBatchKMeans`: parallelism is `min(batch_size // 256, n_cores)`, so use a larger
  `batch_size`; fewer `n_init`; fit on a subsample and `predict` on the rest.
- `PCA(svd_solver="randomized")` for a few components of large data; `float32` input is preserved
  by many estimators and halves memory.

## laspy, lazrs and LASzip

- Backends: laspy prefers `lazrs` (Rust; multi-threaded decompression) and falls back to LASzip
  (single-threaded; needed for waveform data). Check with `laspy.compression.LazBackend.detect_available()`;
  make sure `lazrs` is installed; without it laspy falls back to single-threaded LASzip.
  One benchmark on a 100-million-point LAZ: LASzip C++ 38 s, laspy with parallel `lazrs` 4.3 s.
- Parallel `lazrs` reads the whole file into memory, so it uses more RAM. For bounded memory use
  `laspy.open(path)` with `chunk_iterator(1_000_000)`; that path decodes chunks with one thread.
  Choose by file size against available RAM.
- Many tiles: parallelize across files (a process pool, one file per worker) and select
  `laz_backend=laspy.LazBackend.Lazrs` (single-thread) per worker to avoid thread oversubscription.
- Selective decompression (LAS 1.4, point format 6 and above, laspy 2.4+): pass
  `decompression_selection=laspy.DecompressionSelection.base().decompress_z().decompress_classification()`
  to skip fields you do not use.
- Do not read whole files you only need a part of: `laspy.open` plus `chunk_iterator`, or read the
  header for bounds and counts first. `laspy.read` loads everything, including unused dimensions.
- Scaled coordinates `las.x/y/z` create `float64` arrays; `las.xyz` makes a new (N, 3) copy. Take
  the arrays you need once, or compute on integer `X/Y/Z` with `header.scales` and `offsets` when
  the next step can work in integers. `las.points[mask]` copies.
- Writing: stream with `laspy.open(out, mode="w", header=...)` and `write_points(chunk)`; keep scales
  and offsets of the input so integer coordinates round-trip. LAZ compression costs several times
  the time of writing LAS; use LAS for intermediate files when disk space allows and compress only
  the final product (the file format and size are a requirement to confirm).

## OpenCV

- Never loop over pixels in Python. Use `cv2` functions, NumPy whole-array ops and `cv2.LUT` for
  per-pixel mappings.
- Workers and threads: OpenCV has its own thread pool. Inside multiprocessing or `DataLoader`
  workers call `cv2.setNumThreads(0)` (or 1). Forked workers with OpenCV and OpenMP can deadlock;
  `setNumThreads(0)` or the `spawn` start method fixes it.
- Contiguity: OpenCV needs contiguous arrays and copies non-contiguous views (`img[:, :, 0]`,
  `img[..., ::-1]`) internally. Change channel order with `cv2.cvtColor` (multi-threaded, several
  times faster than NumPy reversal plus copy), or `np.ascontiguousarray`.
- Buffers: pass `dst=` with the exact output shape and dtype to reuse allocations in loops; a
  mismatched `dst` is silently ignored. Slices are views, so accidental copies per frame are a common
  cost.
- Resize: `INTER_AREA` for downscaling, `INTER_LINEAR` for general use. Work at the lowest
  resolution that meets accuracy (half the size is about 4x less work). For large JPEGs use
  `cv2.imread(path, cv2.IMREAD_REDUCED_COLOR_4)` (or `_2`, `_8`): the decoder scales while
  decoding, which is much faster than a full decode plus resize. It is nearest-neighbour style for
  non-JPEG files, so it is only worth it for JPEG.
- `cv2.remap`/`warpAffine` with precomputed maps and matrices reused across frames.
- Writing: PNG compression level (`IMWRITE_PNG_COMPRESSION`) and JPEG quality trade size for time;
  use a low level for intermediates.
- `cv2.UMat` (OpenCL) only pays for chains of heavy operations on large images; check
  `cv2.ocl.haveOpenCL()`. The pip wheels have no CUDA modules.
- Converting between NumPy, OpenCV and torch: keep `uint8` until the last step; convert to
  `float32` and normalize once, ideally on the GPU.

## protobuf (Python)

- Backend: modern `protobuf` wheels use `upb` (native). The pure-Python backend is orders of magnitude
  slower (parsing in single-digit MB/s against hundreds of MB/s). Check it:
  `from google.protobuf.internal import api_implementation; api_implementation.Type()` should not
  be `"python"`; make sure `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python` is not set in production,
  and that generated `_pb2.py` files match the installed runtime.
- Large numeric arrays inside messages: use packed `repeated` scalar fields (default in proto3)
  and convert in bulk: `np.asarray(msg.values)` (native fast path, dtype follows the field type)
  rather than iterating. For big dense arrays (point clouds, images, tensors), a `bytes` field holding
  `arr.tobytes()` with `np.frombuffer(msg.data, dtype=...)` plus shape and dtype fields is faster
  and avoids per-element objects. That is a schema change and an external contract: propose it,
  do not make it silently.
- Avoid reflection in hot paths (`ListFields`, `json_format.MessageToDict`, `DESCRIPTOR` walks);
  prefer direct field access. String fields validate UTF-8; use `bytes` for binary data.
- Reuse messages with `Clear()`/`ParseFromString` instead of allocating new ones for each record;
  note `MergeFromString` merges and does not replace.
- Many small messages: batch them into one message with a repeated field, or length-prefix and
  parse in a stream. Serialization cost grows with the number of fields and nesting depth.
- Do not `CopyFrom` or serialize the same large message repeatedly; serialize once and reuse the bytes.
- Messages above 2 GB cannot be serialized; stream large datasets as a sequence of messages.

## POT (Python Optimal Transport)

- Cost and memory: exact `ot.emd` is O(n^3 log n) time and O(n^2) memory (it needs the full
  n x m cost matrix). Roughly n beyond a few tens of thousands is impractical. First reduce the
  problem: voxel-downsample or subsample the point sets, use histograms/clusters, or minibatch OT,
  before tuning the solver.
- `ot.emd`/`emd2`: `M` should be C-contiguous `float64` (other dtypes are converted, which copies).
  `emd2` returns only the cost; use it when you do not need the plan. Check the
  `numItermax reached` warning: the result is then not optimal, so raise `numItermax` or shrink the
  problem. `check_marginals=False` only when the masses are already equal. Warm start with
  `potentials_init=(alpha, beta)` from a previous solve when solving a sequence of similar problems.
- Threads: `numThreads` is ignored or slower depending on the POT version; recent docs say the
  network simplex no longer uses OpenMP, and a reported benchmark found more threads slower.
  High CPU use with `numThreads=1` usually comes from BLAS in `ot.dist` or NumPy; use
  `threadpool_limits` and measure.
- Sparse costs: `emd` accepts a sparse `M`. When only nearby points may be matched (a kNN or radius
  graph), a sparse cost avoids the dense matrix; this changes the problem, so it is a behaviour
  decision.
- Sinkhorn: iterations depend on the regularization `reg`; small `reg` means many iterations and
  numerical problems (use `sinkhorn_log` or `sinkhorn_stabilized`, or epsilon scaling), and can end
  up slower than exact EMD. Set `stopThr`/`numItermax` deliberately, and warm start across
  related solves. One cost matrix with several target histograms can be solved at once by passing
  `b` as a matrix.
- Large point clouds: use `ot.solve_sample(..., method="geomloss_multiscale"|"geomloss_online", lazy=True)`
  or GeomLoss directly (GPU, linear memory with KeOps; tensorized mode is O(n^2) memory), or sliced
  Wasserstein (`ot.sliced_wasserstein_distance`, O(n log n) per projection) when an approximation
  is acceptable. Approximation changes results: agree on the tolerance.
- Backends: torch tensors on GPU run Sinkhorn on the GPU, but `emd` copies to the CPU solver, so
  GPU gives no benefit for exact EMD. Compute `ot.dist` on the same device as the data, and avoid
  moving the cost matrix back and forth.
