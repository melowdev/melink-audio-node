# Performance checks

Run the session lifecycle benchmark from the repository root:

```powershell
node bench/api.js --iterations=500 --concurrency=20
```

`npm run benchmark` runs the defaults (500 iterations, 20 workers). The script
repeatedly creates and deletes authenticated sessions against a local
ephemeral HTTP server and prints JSON with throughput and process memory
measurements. The default run is suitable for local comparisons; the CI smoke
run uses 100 iterations and 10 workers.

This benchmark does **not** join Discord voice, download media, run FFmpeg, or
measure active audio players. It cannot substantiate active-stream RAM/CPU or
latency claims. Compare results only on equivalent hardware, Node versions,
and operating systems, and retain raw output with any published result.
