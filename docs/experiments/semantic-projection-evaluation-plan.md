# Semantic Projection Evaluation Plan

## Goal

Evaluate whether Jev-powered semantic projection in Desktop Commander reduces host-model context usage and total cost without materially reducing task quality or making workflows slower.

The experiment compares **normal Desktop Commander** against **Desktop Commander with semantic projection** on the same tasks, same source snapshot, and same model.

The primary question is:

> How much host-model context can semantic projection avoid at equal task quality, and what Jev cost and latency does that tradeoff require?

## Experiment design

Run two conditions for every benchmark task:

- **Baseline:** current Desktop Commander behavior with no projection.
- **Treatment:** the same Desktop Commander tool/workflow with semantic projection enabled.

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

### Quality
- task success;
- relevant evidence found;
- relevant evidence missed;
- false positives;
- factual errors;
- answer completeness.

### Context
- source bytes/lines considered;
- Desktop Commander result bytes exposed to the host model;
- host-model input tokens;
- host-model output tokens;
- context reduction percentage.

### Cost
- host-model input/output cost when available or estimable;
- Jev input/output tokens;
- Jev estimated cost;
- combined estimated cost.

### Time
- ordinary Desktop Commander acquisition/read time;
- Jev round-trip time;
- total projection time;
- end-to-end task wall-clock time.

### Agent behavior
- total tool calls;
- number of follow-up reads;
- number of recovery reads after projection;
- whether the agent had to request source that projection initially withheld.

## Core comparison

For each benchmark produce a table like:

| Metric | Baseline | Projection |
| --- | ---: | ---: |
| Task quality / recall | | |
| Source bytes considered | | |
| Bytes exposed to host model | | |
| Host input tokens | | |
| Jev input tokens | 0 | |
| Jev estimated cost | $0 | |
| Host-model estimated cost | | |
| Total estimated cost | | |
| Tool calls | | |
| Follow-up reads | | |
| End-to-end time | | |

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
