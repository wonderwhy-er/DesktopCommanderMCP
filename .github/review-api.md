# AI review API

`npm run review -- A..B` reviews the frozen head B through OpenAI Responses, using the same read-only broker locally and in GitHub Actions. It preserves the review JSON contract, source checks, coverage evidence and text check's `not checked` findings. No API key means exit 1 before any review work.

Set `OPENAI_API_KEY` locally. CI uses the repository secret `OPENAI_API_KEY`, passed explicitly from `tests.yml` to the reusable `review.yml`. Keys belong in the credential store or GitHub secrets, never in tracked files or command arguments. This tool does not read or change Codex subscription authentication.

GitHub publishes reviews only when the repository variable `REVIEW_POST_ENABLED` is exactly `true`. Leave it unset or `false` during cutover: code reviews still run and upload artifacts, with the posting job skipped.

The default review role is `gpt-6.1-sol` at `medium` reasoning. `REVIEW_MODEL` overrides `OPENAI_MODEL`; `REVIEW_REASONING_EFFORT` overrides `OPENAI_REASONING_EFFORT`. In CI configure repository variables `REVIEW_MODEL` and `REVIEW_REASONING_EFFORT`; empty variables retain the defaults. Use `high` for a difficult review. The separate small judging role may use `gpt-6-luna` at `low` or `medium`; changing that role does not require changing the review role.

The broker exposes only file reads inside an exported head and its diff. A text check also permits bounded read-only git/gh commands without a shell. Broker subprocesses inherit no OpenAI key or unrelated secret. A GitHub token reaches only gh for its read operations. The model has no arbitrary shell, web, write or subprocess tool. The loop allows 8 tool calls for code or 16 for text, 20 response turns, and 12 minutes total. Tool output is bounded and credentials are redacted before the next request. Incomplete responses, HTTP errors and credential echoes fail the review. `answer.json` records usage; `session.jsonl` records redacted API output.

Offline checks: `node --test test/test-openai-review.js` plus the repository's existing CI review test suite. Tests use injected fetch or a loopback HTTP server and synthetic credentials. `REVIEW_OPENAI_URL` is restricted to the official endpoint or a loopback test server.

After provisioning a key, run `npm run review -- HEAD~1..HEAD --out test-results/openai-canary` on a small, known change. Check the reported head, model, usage, source evidence and absence of credentials in artifacts. Then run `npm run review -- HEAD~1..HEAD --text .github/review-api.md --out test-results/openai-text-canary`. Offline checks do not establish live account or model access.

Rollback: revert the migration commit in the candidate branch, restore the previous Gemini workflow variable and secret mapping, and rerun the previous review command. Keep the old Gemini secret until the OpenAI canary and first CI review succeed. This change does not delete or rewrite historical Gemini results or evaluations.

API compatibility: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) requires Responses for tool calling; the [function calling guide](https://developers.openai.com/api/docs/guides/function-calling) documents function outputs linked by `call_id`.
