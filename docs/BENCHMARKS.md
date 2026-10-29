# Memory and Performance Benchmark

MailSentry's memory design is validated with a reproducible synthetic benchmark. Numbers below are measured, not projected. They describe the local core and synthetic provider only; they are **not** provider throughput or real-network latency claims.

## Environment

| Item         | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| Date         | 2026-10-28                                                          |
| OS           | Ubuntu 26.04 LTS on WSL2 (kernel 6.18.33.2-microsoft-standard-WSL2) |
| CPU          | AMD Ryzen 7 8700F 8-Core Processor                                  |
| RAM          | 15.8 GiB                                                            |
| Node.js      | v22.23.2                                                            |
| npm          | 10.9.8                                                              |
| Architecture | linux x64                                                           |
| Network      | None used by the benchmark                                          |

## Methodology

- Each scenario runs in its **own Node.js process** so peak RSS is isolated.
- Peak RSS is read from `/proc/self/status` `VmHWM` at the end of the scenario; on non-Linux systems the code falls back to current `process.memoryUsage().rss`.
- Mailbox data is generated with a fixed seed (LCG) for repeatability: 70% Inbox, 15% Spam, 15% Trash; messages 400–1,300 days old; message sizes 15 KB–4 MB; synthetic subject/sender strings; ~11% bulk-classified.
- The scan selects **Inbox + Spam**, action **Move to Trash**, filter **older than 365 days**. Protections exclude starred/unread/important messages, so eligible < scanned.
- Execution scenarios are **dry runs** (revalidation reads only) unless cancellation is the subject; the synthetic mutation methods are never called by the benchmark.
- Batch size 25, concurrency 3, page size 50, preview sample 100, problem-result sample 100.
- Provider API call counts come from the synthetic provider's counters.
- Each scenario sends no HTTP request and performs no DNS lookup.

**Important:** the synthetic fixture holds the entire generated mailbox in the benchmark process, whereas the real application retains only one page of provider metadata at a time plus eligible IDs and bounded samples. The measured peaks are therefore conservative for the application core.

## Scenarios

| Scenario     | Messages | Workload                                                           |
| ------------ | -------: | ------------------------------------------------------------------ |
| `scan-2k`    |    2,000 | Paginated scan + preview plan                                      |
| `scan-30k`   |   30,000 | Paginated scan + preview plan (larger workload)                    |
| `dryrun-20k` |   20,000 | Scan + dry-run execution (revalidation reads)                      |
| `cancel-5k`  |    5,000 | Dry run with 1 ms simulated provider latency, aborted after 100 ms |
| `rate-300`   |      300 | Dry run through a 100 request/second token-bucket limiter          |

## Measured results

| Scenario     | Eligible | Processed |      Peak RSS | Heap used |  Elapsed | API calls             | Cancelled |
| ------------ | -------: | --------: | ------------: | --------: | -------: | --------------------- | --------- |
| `scan-2k`    |    1,648 |         0 |  **63.4 MiB** |   6.6 MiB |    15 ms | 35 list               | No        |
| `scan-30k`   |   24,739 |         0 | **126.7 MiB** |  35.4 MiB |   388 ms | 511 list              | No        |
| `dryrun-20k` |   16,460 |    16,460 | **116.9 MiB** |  29.2 MiB |   197 ms | 340 list + 16,460 get | No        |
| `cancel-5k`  |    4,096 |       246 |  **69.4 MiB** |   9.3 MiB |   226 ms | 85 list + 249 get     | **Yes**   |
| `rate-300`   |      251 |       251 |  **55.2 MiB** |   6.7 MiB | 1,574 ms | 6 list + 251 get      | No        |

Raw JSON for the latest run is written to `bench/results/latest.json` (ignored by Git) with the environment block and per-scenario data.

### Interpretation

- **Memory grows sublinearly in surfaced state.** A 15× increase in messages (2k → 30k) raised peak RSS by ~63 MiB (63.5 → 126.3 MiB), most of which is the synthetic in-process mailbox and generated metadata, not retained scan state. Retained application state is one ID/folder per eligible message plus a 100-row sample.
- **Baseline Node process cost is ~55–63 MiB.** Empty/rate-limited scenarios sit near this baseline.
- **No unbounded retention observed.** The 30k scan did not hold subjects/senders for all messages; the preview sample remained capped at 100.
- **Dry-run reads dominate API call count** (one revalidation GET per eligible message). Real provider latency and quotas, not local CPU, would dominate wall time.
- **Cancellation works under latency.** The 100 ms abort stopped after 243 of 4,096 eligible messages. The provider saw 246 GETs (three in-flight reads beyond the processed count); the executor reported `cancelled=true` and does not claim rollback. In a real mutation run, in-flight operations are reported as uncertain.
- **Rate limiting restores backpressure.** A 100 req/s 300-message dry run took ~1.57 s with 251 get calls and stayed at baseline memory. This is a pacing check, not a throughput benchmark.
- **Timing is single-run and CPU-cache sensitive.** Treat millisecond figures as indicative; RSS is the primary metric. No `--expose-gc` was used.

## Memory budget

Initial budget for the MVP, based on these measurements:

> **Peak RSS ≤ 200 MiB for a 30,000-message synthetic scan** on a comparable Node 22 environment.

Current measured peak is **126.3 MiB**, leaving ~36% headroom. The budget is intentionally conservative and includes the synthetic mailbox; the real application's retained state is smaller. Exceeding 200 MiB in this benchmark should trigger investigation of page retention, sample growth, or accidental full-mailbox buffering. This budget is not a claim about browser memory or provider-side limits.

## Reproduction

```bash
npm ci
npm run bench
```

This compiles the server and runs `dist/bench/memory.js`. Each scenario is spawned as a separate process. The command exits non-zero on a scenario failure and prints a summary table.

To change workloads, edit the `SCENARIOS` array in `src/bench/memory.ts` (message counts, cancellation delay, simulated rate). The benchmark deliberately avoids external services, so results are deterministic apart from scheduling noise.

## Limitations

- Synthetic metadata is not identical to real Gmail/Graph payloads; real subjects/senders can be longer and provider SDK overhead is absent.
- No network latency, retry pacing, TLS, or server-side quota behavior is modeled. The `rate-300` scenario models local token-bucket pacing only.
- WSL2 memory accounting and shared caches can vary between runs.
- Peak RSS includes V8 heap growth from generating the synthetic mailbox; this overstates the app's own retention.
- Only Linux peak measurement is precise; other platforms fall back to current RSS.
- The benchmark does not measure the browser UI, DNS resolution, disk I/O (there is none), or OAuth flows.
- A single reference machine is not a performance guarantee for other hardware.
