# Semantic Projection Evaluation Plan

## Goal

Evaluate whether Jev-powered semantic projection in Desktop Commander reduces host-model context usage and total cost without materially reducing task quality or making workflows slower.

The experiment compares three agent conditions on the same tasks, source snapshot, host model, and model settings:

1. **Bare Claude Code** using its native tools (Read/Grep/Bash/etc.) with no Desktop Commander MCP.
2. **Normal Desktop Commander** with semantic projection disabled.
3. **Smart Desktop Commander** with semantic projection enabled.

The primary question is:

> At equal retrieval/task quality, how do bare Claude, normal Desktop Commander, and Smart Desktop Commander compare on host-model tokens/cost, end-to-end speed, and agent work?

## Experiment design

Run three conditions for every benchmark task:

- **Bare host baseline:** Claude Code native tools only; no Desktop Commander MCP.
- **Desktop Commander baseline:** current Desktop Commander behavior with projection disabled and semantic fields absent from the advertised MCP tool surface.
- **Smart Context treatment:** Desktop Commander with semantic projection enabled, followed by ordinary recovery/verification reads as needed.

Keep constant:
- repository/source snapshot;
- user prompt;
- host model and model settings;
- allowed tools;
- machine/environment.

Run each condition multiple times where model nondeterminism matters.

Measure both:
1. **Tool-level effects** — bytes/tokens/latency for the exact read operation.
2. **End-to-end agent effects** — task success, total tool calls, total context, total cost, and wall-clock time.

## Benchmark 1 — Large single file

Source:
- `src/server.ts`
- approximately 1,734 lines / 88 KB in the current benchmark snapshot.

Task:

> Explain all places in `src/server.ts` involved in PDF support: reading PDFs, exposing PDF tools, creating or modifying PDFs, and dispatching PDF-related behavior. Cite the relevant line ranges and summarize each responsibility.

Conditions:
- Baseline: ordinary `read_file` workflow.
- Treatment: `read_file` with semantic projection, followed by ordinary precise reads if needed.

Ground truth:
- build a reviewed list of all PDF-related sections in `src/server.ts`;
- label each expected section/range as relevant;
- score whether the run found each section.

Primary quality metric:
- recall of relevant PDF sections.

Secondary metrics:
- precision of returned chunks;
- follow-up reads needed;
- bytes/tokens exposed to host model;
- Jev tokens/cost;
- tool latency and end-to-end latency.

## Benchmark 2 — Repo-wide analytics / telemetry audit

Current snapshot characteristics:
- roughly 37 relevant code/doc files;
- roughly 17,154 lines;
- roughly 687 KB across files containing analytics/telemetry-related material.

Task:

> Audit Desktop Commander's analytics and telemetry implementation. Find all relevant code and documentation and explain:
> - where telemetry/events are emitted;
> - how telemetry is enabled or disabled;
> - how UI-origin calls are suppressed;
> - installation and usage tracking;
> - remote-related telemetry;
> - documentation describing telemetry/privacy behavior;
> - inconsistencies between implementation and documentation.

Baseline workflow:
- search normally;
- inspect search results;
- read relevant files/ranges;
- search again as needed.

Treatment workflow:
- same tools and model;
- semantic projection may rank/filter candidate files and read ranges;
- ordinary follow-up reads remain available.

Ground truth:
- manually curate the relevant file set and expected concepts from the current repository snapshot;
- record which files are essential versus merely incidental.

Primary quality metrics:
- relevant-file recall;
- expected-concept recall.

Secondary metrics:
- false-positive files;
- number of tool calls;
- follow-up/recovery reads;
- total Desktop Commander result bytes exposed to host model;
- host-model input/output tokens and estimated cost;
- Jev tokens and estimated cost;
- end-to-end wall-clock time.

## Benchmark 3 — Large Desktop Commander audit/log analysis

Sources:
- `~/.claude-server-commander/tool-history.jsonl`
- `~/.claude-server-commander/claude_tool_call.log`

Current local snapshot is roughly 8.6 MB combined. The JSONL audit currently contains roughly 1,392 entries, including many error/failure/timeout-like outputs and slow calls.

Task:

> Analyze this Desktop Commander audit history. Identify recurring failures/timeouts and unusually slow operations. Group the major failure patterns, identify which tools are most involved, and provide representative evidence for each pattern.

For the process-output path, stream or emit the audit data through a read-only process and inspect it using `read_process_output`.

Conditions:
- Baseline: ordinary process-output/log reading.
- Treatment: `read_process_output` with semantic projection.

Ground truth:
- deterministically calculate basic facts from JSONL before the run:
  - entry count;
  - tool distribution;
  - entries exceeding fixed duration thresholds;
  - obvious error/failure/timeout signal counts;
- manually review representative failure clusters used for semantic-quality scoring.

Primary quality metrics:
- recall of known failure categories and slow-operation categories;
- correctness of representative evidence.

Secondary metrics:
- bytes/tokens exposed to host model;
- Jev cost;
- number of reads/recovery reads;
- latency.

## Metrics to record for every run

The benchmark should be interpreted through three primary dimensions.

### 1. Quality / what was found

Use a reviewed **gold set** for each task rather than subjective answer quality alone.

Record:
- gold items / relevant evidence found;
- gold items / relevant evidence missed;
- recall = found / total gold items;
- false positives;
- factual errors;
- answer completeness.

The primary quality requirement is high recall. Smart Context is not a win if it saves tokens by hiding required evidence.

### 2. Tokens and cost

Record host-model token usage separately:
- uncached/new input tokens;
- cache-creation input tokens;
- cache-read input tokens;
- **total host-model processed input = input + cache creation + cache read**;
- host-model output tokens;
- host-model estimated/actual cost.

For Smart Context also record separately:
- Jev input/output tokens;
- Jev estimated cost;
- combined host + Jev cost.

Do not merge cheap Jev tokens into host-model tokens when presenting the result. The point of the system is explicitly to trade cheap retrieval-model tokens for expensive/scarce frontier-model context.

Also record where available:
- source bytes/lines considered;
- source bytes/lines exposed to the host model;
- source context reduction percentage.

### 3. Speed / agent work

Record:
- end-to-end wall-clock time;
- total agent turns;
- total tool calls;
- tool-call mix;
- follow-up reads;
- recovery reads after projection;
- whether omitted content had to be fetched later;
- Jev round-trip / projection latency for Smart Context.

Tool-level latency is secondary; end-to-end completion time is the primary speed measure.

## Core comparison

For each benchmark produce a three-way table like:

| Metric | Bare Claude | Normal DC | Smart DC |
| --- | ---: | ---: | ---: |
| Gold items found | | | |
| Recall | | | |
| False positives / factual errors | | | |
| Host processed input tokens | | | |
| Host output tokens | | | |
| Host-model cost | | | |
| Jev input tokens | 0 | 0 | |
| Jev estimated cost | $0 | $0 | |
| Combined estimated cost | | | |
| Source exposed to host model | | | |
| Tool calls | | | |
| Agent turns | | | |
| Recovery reads | | | |
| End-to-end time | | | |

## Primary success metric

The main metric is:

> **Context reduction at equal task quality.**

A useful summary for a policy would look like:

> At at least 95% of baseline task quality, semantic projection reduced host-model source context by X%, added $Y of Jev cost, changed total task cost by Z%, and changed end-to-end latency by T%.

This is preferable to optimizing for a fixed number of chunks or for raw Jev confidence alone.

## Important interpretation rules

- A large context reduction is not a win if relevant evidence is missed.
- A cheap projection is not a win if it causes several recovery reads.
- Projection-tool latency should not be evaluated alone; the relevant latency is end-to-end task time.
- Context savings matter even when users are not billed directly per token because context windows, usage quotas, compaction, and model latency are still scarce resources.
- The baseline must reflect competent current Desktop Commander usage, including search and precise reads, rather than an intentionally wasteful full-repository dump.

## Follow-up experiment: shadow mode

After the controlled benchmark, consider a shadow mode:

- return the normal Desktop Commander result to the host model;
- run semantic projection in parallel for measurement only;
- record what projection would have exposed/withheld;
- compare withheld material against later agent reads and actions.

This permits real-world evaluation of potential false negatives without changing user-visible task quality.

## Decision criteria

Continue toward productization only if the treatment demonstrates substantial context reduction while keeping task quality near baseline.

Initial target worth testing:
- at least 70% reduction in source context exposed to the host model;
- at least 95% of baseline relevant-evidence recall / task quality;
- total estimated cost lower than baseline or clearly justified by context savings;
- no material degradation in end-to-end latency;
- low recovery-read rate.

These are experiment targets, not product claims; the benchmark results should determine the final thresholds.

## Telemetry benchmark run — 2026-09-20

Three primary conditions were run on the same repository snapshot, Sonnet model, medium effort, and audit prompt.

| Metric | Bare Claude | Normal DC | Smart DC (forced projection) |
| --- | ---: | ---: | ---: |
| Frozen gold score | 12 / 15 | 10.75 / 15 | 11.75 / 15 |
| Gold score % | 80.0% | 71.7% | 78.3% |
| End-to-end time | 212.3 s | 179.4 s | 201.9 s |
| Tool calls | 48 | 31 | 32 |
| Primary Sonnet processed input | 43.7k | 710.5k | 739.2k |
| All Claude-model processed input | 2.373M | 711.1k | 739.7k |
| Claude output tokens | 14.7k | 11.2k | 11.6k |
| Claude cost | $0.480 | $0.736 | $0.761 |
| Jev input / output | 0 / 0 | 0 / 0 | 71.3k / 2.47k |
| Jev cost | $0 | $0 | $0.0030 |
| Combined cost | $0.480 | $0.736 | $0.764 |

Bare Claude used the native Agent tool once; most of its work was delegated to Haiku. Therefore its primary Sonnet context was low, but all Claude models combined processed about 2.37M input tokens. Report both values rather than only the top-level Sonnet usage.

### Smart Context projection details

The forced Smart run made 9 projected reads. Across those reads:
- 5,188 source lines were considered;
- 2,510 lines were exposed to Claude;
- 2,678 lines were withheld (51.6%);
- 64 of 132 chunks passed the relevance gate;
- Jev used 71,311 input and 2,470 output tokens;
- Jev cost was approximately $0.0030;
- cumulative Jev latency was ~7.1 seconds.

The broad telemetry task often made most of a file relevant: setup and uninstall projections exposed ~86% of their source, while `server.ts` projections exposed only ~11–15%. Context filtering therefore varies strongly by source/task shape.

### Interpretation

This run does **not** demonstrate a Smart Context efficiency win over normal Desktop Commander. Compared with Normal DC, forced Smart was ~12.5% slower, used ~4.0% more Claude processed input, and cost ~3.9% more, while improving preliminary gold-set coverage from 71.7% to 78.3%.

A separate natural Smart run, with the Smart schema advertised but no special system instruction, made zero projection calls. This is a product-discoverability/automatic-policy finding: advertising the projection parameter alone is not enough to make the host agent reliably use Smart Context.

The bare Claude baseline is also structurally important. Claude Code used its native Agent tool and delegated heavily to Haiku. That made its Sonnet context very small and its dollar cost lowest despite much higher total model-processed input. Smart Context should therefore be compared against native agent delegation/orchestration, not only against ordinary Desktop Commander search/read loops.

The frozen gold set for this run is `/tmp/dc-telemetry-benchmark-gold.md`; scoring is preliminary manual scoring and should be reviewed before treating the percentages as publication-quality benchmark results.

## Whole-repository semantic retrieval experiment — 2026-09-20

A follow-up tested a different Smart Context architecture: instead of making individual `read_file` calls smarter, `read_multiple_files` recursively expanded a repository root, chunked text/code across files, evaluated chunks with Jev in bounded concurrent batches, and returned selected chunks with file/line provenance.

Filtered corpus: ~66k lines / ~2.4 MiB across ~324 source/doc/text files after excluding generated/dependency/lock/oversized noise.

### Findings

- A first coarse 80-line pass at minRelevance 0.65 selected ~10.4k lines / 388.5 KiB (84.2% withheld), at ~$0.035 Jev cost and ~5.3s wall-clock projection time. This was still too large for Claude Code's inline MCP result limit.
- Progressive semantic zoom (re-chunk selected regions at 20, then 10 lines with the same quality gate) reduced exposure to ~2,285 lines / 87.6 KiB (96.4% withheld), at ~$0.0468 Jev cost and ~14.0s wall-clock. Still slightly too large once provenance headers were included.
- Refining further to 5-line chunks reduced exposure to ~1,345 lines / 55.6 KiB (97.7% withheld), at ~$0.0524 Jev cost and ~11.8s wall-clock. The MCP response was ~87k characters including provenance and still crossed Claude Code's inline tool-result ceiling.

### Architecture conclusion

Whole-repo semantic scanning is economically and latency-wise plausible. The remaining problem is not retrieval quality alone; it is delivery policy. A Smart Context repo tool should be budget-aware and reversible:

`repo/source corpus -> Jev semantic map -> relevant spans -> compact manifest + bounded evidence payload + retrieval handle`

Do not blindly return every span above the relevance gate. Preserve the quality gate, but when relevant evidence exceeds the host-context budget, return a compact index/grouped manifest and enough evidence to start, while retaining handles for adjacent/original/more retrieval. Progressive semantic zoom can reduce irrelevant neighbors before applying that delivery policy.

This suggests Smart Context should operate above `read_file`: repo/candidate-set retrieval, search result filtering, process/log filtering, and large multi-file reads should share one semantic retrieval layer.

## Product-shaped Smart Context hypothesis experiments — 2026-09-20

### Corrected product hypothesis

The product direction is not an external Haiku synthesis worker. That was only a control showing the value of context isolation. The DC-native hypothesis is:

> High-context Desktop Commander tools should accept semantic questions describing what evidence the host needs. DC uses Jev to score machine context against those questions, deterministically packs original source evidence under a host-context budget, preserves file/line provenance and retrieval handles, and returns one answer-ready evidence package.

Candidate tools: read/read_multiple_files, list/directory discovery, search/search results, start_process/read_process_output. Jev should only run when the output/source is large enough to justify it.

### Experiment A — broad faceted manifest + verification

- 7 semantic questions over the ~69k-line repo.
- Jev: ~$0.081, ~20.4s wall time.
- Manifest: ~37 KB, grouped relevant ranges by semantic question.
- Parent still made 25 read_file verification calls / 27 turns.
- Parent: ~$0.588, ~225s.
- Combined: ~$0.669, ~245s sequential.
- Preliminary gold heuristic: ~80%.

Conclusion: semantic organization improved recall, but a manifest alone does not remove the parent discovery/verification loop.

### Experiment B — 7-question bounded original-evidence package

- DC deterministically packed original Jev-selected excerpts under ~60 KB host budget; no model-written summary.
- Package: 51 blocks / 31 files / ~55.7 KB.
- Parent used zero tools and one turn.
- Parent: ~$0.147, ~76s.
- Jev + parent: ~$0.228, ~97s sequential.
- Preliminary gold heuristic: ~60%.

Conclusion: economics and parent-turn isolation are excellent, but global relevance packing loses important evidence.

### Experiment C — 12 semantic questions

Questions explicitly separated transport, config/opt-out, UI suppression, generic tool telemetry, tool-specific telemetry, lifecycle events, remote behavior, local usage, install/setup/uninstall, docs, inconsistencies, and Smart Context telemetry.

- Jev: 2.90M input tokens, ~$0.122, ~29.7s wall time.
- 60 KB global package + one-turn parent: parent ~$0.137 / ~73s; preliminary gold ~63%.
- Balanced per-question ~71 KB package + one-turn parent: parent ~$0.150 / ~69s; combined ~$0.273 / ~99s sequential; preliminary gold ~66%.

Compared with existing telemetry baselines:

| Condition | Time | Total cost | Parent/tool loop | Preliminary quality signal |
| --- | ---: | ---: | --- | ---: |
| Bare Claude Code | ~163s | ~$0.310 | native Haiku subagent + Sonnet | ~80% |
| Normal DC | ~192s | ~$0.672 | 32 turns | ~72% |
| Adaptive per-tool Smart DC | ~141s | ~$0.642 | 25 turns | ~78% but missed install/setup details |
| Jev question map + verification | ~245s | ~$0.669 | 27 turns | ~80% |
| Jev 12-question bounded evidence package | ~99s | ~$0.273 | 1 parent turn | ~66% |

### Main finding

The strongest product architecture is the bounded evidence package, not Jev filtering on every individual tool call. It can move most discovery work out of the expensive parent context and materially beat normal DC on cost/time. Current blocker is recall/evidence-selection quality.

Simple relevance score + byte budget is insufficient. The next retrieval policy should optimize **coverage and novelty per semantic question**, not only relevance. A likely design is: broad question-specific Jev scoring -> deduplicate/cluster candidate evidence -> second-stage coverage/novelty judgment or deterministic structural diversity -> bounded original evidence package -> retrieval handle for omitted/adjacent evidence.

Do not treat the current ~66% quality score as production-ready. The economics are promising only if evidence recall can approach the normal/bare baseline.

### Experiment D — atomic semantic questions + fine semantic zoom + local bundles

This is the strongest result so far and materially changes the Smart Context architecture.

Method:
- Decompose the broad telemetry task into 20 atomic semantic questions (transport, control, UI suppression, generic tool call telemetry, file/edit/process/search telemetry, startup lifecycle, MCP lifecycle, remote attribution, remote transport, local usage, package install, setup, uninstall, privacy provider, privacy config, inconsistencies, Smart Context telemetry).
- First Jev pass scans the ~69k-line repository at 40-line granularity and scores chunks against those atomic questions.
- Fine-zoom pass only revisits coarse relevant ranges, splits them into 10-line chunks, and asks Jev for direct answer-bearing evidence for the exact atomic question.
- Packing includes high-confidence fine chunks plus immediate left/right neighbors, preserving exact event/config lines just outside the winning fine chunk.
- DC returns original source excerpts with file:line provenance under a ~64 KB host-context payload. No model-written summary and no follow-up retrieval in the parent run.

Metrics:
- Coarse atomic Jev scan: 4,112,836 input tokens, 752,516 output tokens, ~$0.1727 estimated Jev cost, ~23.4s wall time.
- Fine zoom: 305,399 Jev input tokens, 20,591 output tokens, ~$0.0128, ~7.3s wall time.
- Total Jev: 4,418,235 input tokens, ~$0.1856.
- Final evidence package: 1,385 lines / 63,841 bytes.
- Parent: one turn, zero tool calls, ~43,059 all-Claude processed input tokens, ~$0.1422, ~68.0s.
- Combined sequential: ~$0.3278, ~98.7s.
- Preliminary gold heuristic: 13/15 = 86.7%.

Comparison to prior baselines:
- Normal DC telemetry: ~72% quality signal, ~$0.672, ~192s, ~878k processed input.
- Bare Claude Code telemetry: ~80% quality signal, ~$0.310, ~163s, ~786k all-model processed input.
- Atomic/fine Smart Context: ~86.7% quality signal, ~$0.328, ~99s, ~43k parent processed input.

Derived effects versus Normal DC:
- ~51% lower total cost.
- ~49% lower end-to-end sequential time.
- ~95% lower parent-model processed input.
- Higher preliminary evidence coverage.

Versus Bare Claude:
- ~5.7% higher total dollar cost in this run.
- ~39% faster sequential completion.
- ~94.5% lower parent-model processed input.
- Higher preliminary gold heuristic, though scoring is not publication-grade.

Architecture implication:
> Smart Context should treat semantic questions as a coverage contract, not merely a relevance hint. Questions must be sufficiently atomic. DC should use a coarse semantic pass for broad retrieval, fine semantic zoom only inside relevant regions, then include local neighboring context around selected fine spans before delivering a bounded original-evidence package.

Small/raw outputs should still bypass Jev. The host should not choose whether Jev runs; it supplies semantic questions, while DC decides based on source size/type whether to return raw, compute deterministically, or run semantic retrieval.

Remaining work:
- validate on additional ordinary tasks, not only telemetry;
- replace preliminary keyword-based gold scoring with reviewed evidence recall;
- reduce Jev cost by avoiding unnecessary atomic questions/chunks, caching repeated source judgments, and using deterministic structure before semantic passes;
- make omitted evidence reversible through a retrieval handle;
- test automatic generation of atomic semantic questions from normal host task intent.

### Experiment E — sensitivity to semantic-question quality

Concern tested: Smart Context may depend too strongly on the host model generating high-quality atomic semantic questions.

Same telemetry task, same repository, same coarse -> fine zoom -> bounded one-turn parent architecture. Only the question source changed.

| Question source | Questions | Preliminary quality | Total cost | Sequential time |
| --- | ---: | ---: | ---: | ---: |
| Raw task only | 1 | ~56.7% | ~$0.189 | ~89s |
| Haiku-generated | 17 | ~51.1% | ~$0.320 | ~189s |
| Sonnet-generated | 20 | ~61.1% | ~$0.361 | ~178s |
| Hand-atomic reference | 20 | ~86.7% | ~$0.328 | ~99s |

Important findings:
- Question quality is a first-order variable. Plausible-looking generated questions can materially underperform.
- More questions do not imply better coverage. Haiku generated 17 reasonable questions but produced the lowest quality result.
- Generated broad/overlapping questions increase Jev COGS because each repo chunk is judged against more questions and many more regions survive into fine zoom.
- Sonnet question generation can hallucinate environment concepts before seeing source. On the search-lifecycle task it generated `search_files` / `search_code` questions even though the current API uses `start_search` with `searchType`.
- A high-concurrency 20-question Jev pass hit a 429 rate limit; lower concurrency completed successfully but increased wall-clock time.

A source-driven structural-diversity fallback (files + symbols + event/literal signatures + local neighbors) improved the raw-task telemetry result from ~56.7% to ~64.4%, but did not close the gap to hand-atomic questions. Therefore semantic questions should be treated as steering/coverage hints, not as the sole correctness boundary.

Product implication:
> Do not require the host to perfectly decompose the task before DC has seen the environment. A future Smart Context flow should ground or validate semantic questions against a cheap source map / structural scan, supplement them with source-driven coverage, and detect broad/overlapping question sets before paying for a full Jev scan.

### Experiment F — generalization by workload shape

#### Small precise source: bypass Jev

`src/utils/capture.ts` is ~523 lines / 20 KB. Passing the raw file directly to a one-turn Sonnet analysis required no Jev:
- one parent turn;
- ~$0.0486 host-model cost;
- ~28.2s;
- no semantic-retrieval overhead.

This supports an adaptive policy: if the requested source already fits comfortably inside the host-context budget, return it raw.

#### Medium cross-file code investigation: search lifecycle

Task: trace search schemas/exposure, `start_search`, progressive retrieval, stop/list, SearchManager execution, buffering/pagination, errors, limits, timeouts, cleanup.

Sonnet generated 27 semantic questions without source access. Some hallucinated old/nonexistent names (`search_files`, `search_code`), but Jev/source evidence still recovered the actual `start_search` architecture.

Concept-level checklist:
- Bare Claude: 17/17 = 100%.
- Normal DC: 16.5/17 = ~97%.
- New Smart package: 17/17 = 100%.

Economics:
| Condition | Cost | Time | Parent/all-model processed input |
| --- | ---: | ---: | ---: |
| Bare Claude | ~$0.379 | ~163s | ~823k |
| Normal DC | ~$0.400 | ~126s | ~424k |
| New Smart | ~$0.352 total | ~171s sequential | ~28k parent |

New Smart breakdown:
- Sonnet question generation: ~$0.023 / ~16.6s;
- coarse Jev: ~$0.218 / ~88.2s;
- fine Jev: ~$0.008 / ~9.3s;
- one-turn parent: ~$0.103 / ~57.0s.

Interpretation: retrieval quality generalized well and parent context collapsed dramatically, but latency is worse than Normal DC because naive question x whole-repo evaluation is too expensive. The medium task especially argues for cheap structural/file routing before Jev.

#### Large structured logs: deterministic local reduction, no Jev

Frozen audit source: ~8.4 MB. Smart policy used deterministic Python aggregation instead of Jev, producing an ~11 KB evidence package.

One-turn parent:
- ~$0.054;
- ~40.5s;
- no Jev.

Frozen baselines:
- Bare Claude: ~$0.723 / ~304s;
- Normal DC: ~$0.794 / ~413s;
- old per-tool Smart: ~$1.240 / ~626s.

The deterministic answer correctly surfaced the dominant ~10s `read_process_output` waiting pattern, `.profile` missing-env noise, missing `rg`, disconnected command/browser bridge failures, and missing-module failures. This workload strongly supports strategy selection by source type: structured data should be computed locally instead of semantically filtered.

### Updated architecture hypothesis

Smart Context should not be synonymous with Jev. DC should choose among:
1. **Raw pass-through** for small/precise context.
2. **Deterministic local computation** for structured data/logs/tables where the requested facts are computable.
3. **Semantic retrieval** for large unstructured/code/document corpora.

For semantic retrieval, the current best pattern is:
`task intent -> grounded/validated atomic coverage questions -> cheap structural routing -> coarse Jev only on plausible source regions -> fine semantic zoom -> local neighbors -> bounded original evidence + retrieval handle`.

The next major experiment should test **grounded question generation**: DC first returns or internally constructs a compact structural/source map (real file names, symbols, tool/event names), then the host generates/refines semantic questions from that grounded map. This directly attacks both the question-quality risk and the unnecessary whole-repo Jev cost.
## Question-generation sensitivity + workload-shape generalization — 2026-09-20

### Question-generation sensitivity

Same telemetry task, same repo, same coarse Jev retrieval -> fine zoom -> local-neighbor evidence package -> one-turn Sonnet parent. Only the source of semantic questions changed.

| Question source | Questions | Preliminary quality | Total cost | Sequential time | Package |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw task only | 1 | ~52.2% | ~$0.217 | ~82s | ~78.8 KB |
| Haiku-generated | 17 | ~71.1% | ~$0.346 | ~200s | ~52.9 KB |
| Sonnet-generated | 20 | ~66.7% | ~$0.390 | ~181s | ~59.8 KB |
| Hand-atomic reference | 20 | ~86.7% | ~$0.328 | ~99s | ~63.8 KB |

Question generation itself:
- Haiku: ~$0.0263 / ~30.8s.
- Sonnet: ~$0.0285 / ~12.6s.

Important result: stronger host model did not automatically produce a better retrieval contract. Sonnet-generated questions omitted some coverage dimensions that the hand-atomic set separated explicitly (tool-family telemetry, startup lifecycle, MCP lifecycle, Smart Context telemetry). Question quality is therefore a first-class product risk.

### Small source case — 256-line search-handlers.ts

Task: explain search handler lifecycle.
- Source: 256 lines / ~8.2 KB.
- Jev selected 99.85% of source; withheld only 12 bytes.
- Jev overhead: ~$0.00018 / ~0.85s.

Conclusion: semantic filtering should be bypassed for small/high-density inputs because it adds latency/cost without reducing host context.

### Medium source case — 1,022-line search-manager.ts

Task: explain SearchManager startup, rg/find process management, buffering/pagination, timeout/cancel/cleanup, and errors.
- Source: 1,022 lines / ~33.6 KB.
- Jev retained ~60.0%; withheld ~40.0%.
- Jev overhead: ~$0.00054 / ~1.1s.
- Raw one-turn parent: ~$0.0888 / ~39.4s.
- Jev-filtered one-turn parent: ~$0.0488 / ~25.9s.
- Combined Smart: ~$0.0493 / ~27.0s.
- Both raw and Jev answers hit the same simple 7/8 lifecycle coverage heuristic.

Conclusion: medium files are a strong fit for simple one-pass semantic projection. No multi-question/fine-zoom machinery is needed.

### Huge structured source — frozen 8.4 MB tool/audit history

Frozen source: ~8.42 MB.
Agentic baselines:
- Bare Claude: ~304s / ~$0.723.
- Normal DC: ~413s / ~$0.794.
- Adaptive per-tool Smart DC: ~626s / ~$1.240.

Deterministic strategy:
- Local Python aggregation over full history: ~0.06s.
- 8.4 MB -> ~7.1 KB compact statistics/evidence.
- One-turn Sonnet parent: ~24.5s / ~$0.034.
- Correctly distinguishes ~10s read_process_output polling from actual failures and surfaces exact failure groups/counts.

Conclusion: large structured data should preferentially use deterministic local aggregation, not Jev.

### Emerging routing architecture

Smart Context should be a strategy layer, not a universal Jev filter:

1. Small/high-density source -> return raw.
2. Medium unstructured source -> one-pass Jev relevance filtering.
3. Large structured source (JSONL/CSV/log records) -> deterministic local aggregation/query first; Jev only if semantic interpretation remains necessary.
4. Large broad/unstructured source -> semantic questions -> coarse Jev retrieval -> fine semantic zoom -> neighboring original evidence -> bounded evidence package.

Host/question-generation remains an unresolved dependency for case 4. The product needs either question validation/augmentation inside DC or a fallback strategy when semantic questions are broad/incomplete.


## Core research hypothesis — indexless semantic retrieval for live machine context

The point of this work is broader than “use Jev as a reranker” or “add another RAG pipeline.”

The core question is:

> **Can a very cheap query-time semantic judge make traditional RAG unnecessary for a useful class of Desktop Commander context retrieval?**

Desktop Commander frequently works with context that is live, heterogeneous, previously unseen, and often short-lived:

- source code;
- logs and terminal output;
- JSON and CSV;
- Markdown and documentation;
- config files;
- process lists;
- generated reports;
- audit history;
- temporary files;
- arbitrary folders on the user's machine.

Traditional RAG assumes that a corpus is worth indexing ahead of time. Embeddings are computed, stored, maintained, and later queried. That makes sense for large, repeatedly queried knowledge bases.

Desktop Commander often sees a different problem:

> Context appears now, may change immediately, may never be queried again, and may not have a useful domain-specific structure.

For that class of problem, Jev suggests a different retrieval model:

```text
context appears
    ↓
split into chunks
    ↓
judge each chunk against the current task at query time
    ↓
return only relevant evidence
```

No persistent vector index is required.

### The real tradeoff: index-time intelligence vs query-time intelligence

Serena / LSP / tree-sitter:
- extract code structure ahead of time;
- excellent for symbols, definitions, references, call graphs;
- strongest when the answer is represented in code structure.

Traditional vector RAG:
- embeds semantics ahead of time;
- excellent when a corpus is stable and repeatedly queried;
- requires index creation, maintenance, and retrieval infrastructure.

Jev:
- performs semantic judgment at query time;
- is domain/context agnostic;
- can inspect code, logs, docs, config, process output, or mixed context with the same primitive;
- avoids persistent indexing, but pays an O(N)-like scan cost on each query.

The conceptual spectrum is:

```text
PRECOMPUTE / INDEX-TIME                         QUERY-TIME

Serena / LSP      symbols, AST, references
RAG               embeddings / vector index
grep / BM25       lexical index/search
Jev                                                   semantic judgment
frontier LLM                                          full reasoning
```

Jev is interesting because it is far enough toward query-time intelligence to work across arbitrary text-like machine context, while being cheap enough that broad scanning may sometimes be practical.

### Why this matters specifically for Desktop Commander

The strongest use cases are those where code-specific systems such as Serena can fail because the answer crosses multiple context types.

Example:

> Why did the deployment fail?

Relevant evidence may live in:
- Dockerfile;
- package.json;
- shell output;
- CI logs;
- environment/config files;
- README;
- nginx config;
- systemd status.

Or:

> Why is this application using so much memory?

Relevant evidence may span:
- source code;
- process list;
- runtime metrics;
- heap output;
- logs;
- config;
- terminal commands.

This is not naturally a single code graph and not always a stable RAG corpus.

It is **live machine context**.

That is the strategic differentiation we are testing: whether Desktop Commander can retrieve meaningfully across arbitrary machine context without requiring a prebuilt, domain-specific index.

### The whole-repository experiments tested the upper bound

The 69k-line repository experiments should be interpreted as an upper-bound test of indexless semantic retrieval.

They showed:
- query-time semantic scanning is surprisingly affordable;
- large context reductions are possible;
- the main failure mode was not primarily Jev COGS;
- the main failure mode was **recall under broad intent**.

A pointwise judge is naturally good at answering:

> “Is this chunk relevant to this question?”

That does not automatically imply it is good at:

> “Find every distinct piece of evidence required for a complete answer to this broad investigation.”

That distinction is central.

The complicated atomic-question experiments were an attempt to compensate for this coverage problem. They improved recall, but they also introduced dependence on host-generated decomposition and started turning Desktop Commander into its own retrieval/orchestration framework.

That is useful evidence, but it should not obscure the original hypothesis.

### The clean experiment we should run

Before concluding whether Jev is “retrieval” or merely “reranking/filtering,” test retrieval recall directly.

For a corpus with a reviewed gold set of relevant chunks:

1. Use one normal, broad natural-language user task.
2. Run one Jev relevance pass over the corpus.
3. Sweep the relevance threshold.
4. Measure:
   - gold evidence recall;
   - percentage of irrelevant/source context removed;
   - Jev cost;
   - latency.

The key curve is:

```text
context removed  ↔  gold evidence recall
```

The original hypothesis remains alive if there is a useful operating point such as:

> **95%+ gold recall while withholding 70–80%+ of the source context from the host model.**

If achieving 95% recall requires keeping 80–90% of the corpus, then Jev is not replacing retrieval. It is better understood as a reranker or context compressor after another retrieval stage.

### Context types that matter most

This test should focus especially on contexts where classic RAG or Serena are awkward:

- mixed repository: code + docs + config;
- compiler/build output;
- application logs;
- filesystem tree + selected file contents;
- Git diff;
- process output;
- support-ticket corpus;
- CSV plus accompanying documentation;
- arbitrary project folder with no prebuilt index.

The product-level research question is therefore:

> **Can Desktop Commander provide useful semantic retrieval over arbitrary live computer context without first building an index?**

If yes, that is substantially more interesting than adding another conventional RAG layer.

If no, Jev may still be valuable as a cheap reranker/filter within a hybrid retrieval system, but that is a narrower hypothesis.


## Experiment G — clean indexless semantic retrieval benchmark

Purpose: test the original hypothesis directly, without Claude Code, host-generated atomic questions, answer generation, fine zoom, or evidence packing.

Question:

> Given one broad natural-language task and no prebuilt index, can Jev preserve almost all relevant evidence while removing most source context?

### Setup

Corpus:
- DesktopCommanderMCP filtered source/doc/text corpus;
- 328 files;
- 1,918 non-overlapping 40-line chunks;
- ~2.64 MB source text.

Task supplied unchanged to every Jev judgment:

> Audit Desktop Commander's analytics and telemetry implementation. Find all relevant code and documentation and explain where telemetry/events are emitted; how telemetry is enabled or disabled; how UI-origin calls are suppressed; installation and usage tracking; remote-related telemetry; documentation describing telemetry/privacy behavior; and inconsistencies between implementation and documentation.

Gold:
- 28 frozen, explicit file:line evidence anchors derived from the pre-existing 15-concept telemetry gold set;
- anchors cover transport/gating, privacy sanitization, config defaults/opt-out, UI suppression, generic and tool-specific events, lifecycle, remote attribution/privacy, remote transport distinction, local usage, install/setup/uninstall, privacy/provider/retention/config claims, runtime config path, and Smart Context telemetry.

Method:
- one Jev NOUL relevance question per 40-line chunk;
- no task decomposition;
- no host model;
- no second semantic pass;
- save all scores once;
- sweep score thresholds offline and compute gold-anchor recall vs source bytes retained/removed.

### Jev scan metrics

- Jev input: 1,160,919 tokens
- Jev output: 33,374 tokens
- estimated Jev cost: ~$0.0488
- wall time: ~18.2s
- cumulative request latency: ~60.5s across concurrent calls

### Recall vs context reduction

| Threshold | Gold recall | Context retained | Context removed |
| ---: | ---: | ---: | ---: |
| 0.05 | 100% (28/28) | 76.5% | 23.5% |
| 0.10 | 100% | 52.8% | 47.2% |
| 0.15 | 100% | 43.9% | 56.1% |
| ~0.17 | **100%** | **42.0%** | **58.0%** |
| 0.20 | 96.4% (27/28) | 39.6% | 60.4% |
| 0.40 | 96.4% | 30.0% | 70.0% |
| 0.60 | 96.4% | 23.5% | 76.5% |
| 0.70 | 96.4% | 20.7% | 79.3% |
| 0.80 | **96.4%** | **17.2%** | **82.8%** |
| 0.85 | 92.9% | 14.5% | 85.5% |
| 0.90 | 92.9% | 11.7% | 88.3% |
| 0.95 | 35.7% | 3.1% | 96.9% |

### Main result

On this corpus, a single broad natural-language task plus one pointwise Jev pass produced a useful operating curve:

> **96.4% gold-anchor recall while withholding ~82.8% of source bytes from the host.**

If zero gold-anchor loss is required, the same score file supports:

> **100% recall while withholding ~58% of source bytes.**

This is the first experiment that directly supports the original indexless-retrieval hypothesis without relying on hand-crafted task decomposition.

### Important failure mode

At thresholds >= ~0.20, the sole missing gold anchor is:

- `src/config.ts:4-9` — the runtime config path `.claude-server-commander/config.json`.

That chunk scored only ~0.17 even though it is essential evidence for the broader documentation inconsistency: `PRIVACY.md` tells users to edit `~/.desktop-commander/config.json`, while runtime code uses a different path.

This is a meaningful limitation of pointwise relevance judgment:

> A chunk can be important because of its **relationship to another chunk**, while appearing only weakly relevant in isolation.

At ~0.85, the second lost anchor is the Smart Context telemetry documentation chunk; all other 26 anchors remain.

### Interpretation

This result is substantially cleaner than prior end-to-end Claude Code benchmarks because retrieval quality is measured before answer generation.

It suggests that Jev may indeed have a useful role as **indexless query-time semantic retrieval** over moderate heterogeneous corpora:
- no vector index;
- no repository-specific semantic index;
- no host-generated atomic questions;
- one broad natural-language intent;
- high source reduction with high evidence recall.

However, this is one corpus and the gold set was built from a known telemetry investigation. It should not yet be treated as a general result.

The next important validation is to repeat exactly this benchmark shape on heterogeneous live-machine tasks where evidence crosses context types and relationships, especially deployment/debugging snapshots, build output, mixed logs/config/docs, or other contexts where Serena/LSP-style structure is incomplete.
