# Semantic Projection experiment

This branch adds an optional Jev-powered context reduction layer to existing Desktop Commander read tools.

The goal is to let an agent say **what context it needs** without first reading all candidate context into the host model.

## Mental model

Normal read:

```
source -> Desktop Commander -> host model
```

Projected read:

```
source -> Desktop Commander -> Jev semantic selection -> selected context -> host model
```

Existing tools keep normal behavior unless a `projection` argument is supplied.

## Supported tools

### `read_file`

For text results, `projection.mode = "select"` chunks the requested read window by line and returns only the most relevant chunks.

```json
{
  "path": "/tmp/app.log",
  "offset": 0,
  "length": 5000,
  "projection": {
    "mode": "select",
    "instruction": "Find sections that explain refresh-token failures",
    "limit": 5,
    "chunkLines": 40
  }
}
```

Returned chunks preserve line ranges, so the agent can follow up with an ordinary precise `read_file`.

### `read_multiple_files`

Desktop Commander reads candidate files internally and sends bounded samples to Jev. The host receives only selected file paths and relevance probabilities, then chooses which files to read.

The experiment considers at most 64 files and sends at most 12,000 characters per file to Jev.

### `read_process_output`

Projection runs over the requested process-output window and returns only relevant line chunks.

This is useful for verbose builds, logs, tests, and long-running processes where most output is not useful to the host model.

## Enable the experiment

Semantic projection is off by default.

In Desktop Commander settings:

1. Turn on **Semantic Projection**.
2. Leave **Semantic Projection Model** as `jev-latest` unless testing another compatible model.
3. In **Semantic Projection API Key**, paste a TypeSafe/Jev API key and choose **Save key**.

The key input is password-style and is not returned by `get_config`. It is stored separately from ordinary Desktop Commander configuration.

A technical user can alternatively set `TYPESAFE_API_KEY` in the environment.

## Configure from chat without pasting a secret into chat

Save the TypeSafe API key as the only line in a local file, then use the existing `set_config_value` tool with the reserved key `semanticProjectionApiKeyFile`:

```json
{
  "key": "semanticProjectionApiKeyFile",
  "value": "/path/to/typesafe-key.txt"
}
```

Desktop Commander reads the file internally, stores the key, and does not return the key contents to the host model.

## Secret handling

The stored key lives in:

```
~/.claude-server-commander/semantic-projection-secrets.json
```

On POSIX systems Desktop Commander creates it with owner-only file permissions (`0600`).

The config UI reuses the existing `set_config_value` tool with the reserved key `semanticProjectionApiKey`. Desktop Commander intercepts that key, stores the value in the separate secret file instead of `config.json`, and redacts the value from stderr/tool logs and tool history. UI-origin calls are also excluded from analytics telemetry.

This experiment does not yet use macOS Keychain or Windows Credential Manager.

## Privacy boundary

When semantic projection is used, source content being evaluated is sent from Desktop Commander to the configured TypeSafe/Jev API.

That is why the feature is opt-in and disabled by default. Normal reads do not use the provider unless the caller supplies `projection`.

## Current limitations

- Only `mode: "select"` is implemented.
- `read_file` projection currently targets normal text results; image/PDF-specific rendering keeps existing behavior.
- Multi-file projection ranks bounded file samples rather than recursively searching chunks inside every file.
- No projection is added to command execution itself. Execution remains separate from semantic inspection of process output.

## Possible next steps

- Add `evaluate` mode for typed Jev questions without returning raw source content.
- Add tournament/chunked selection for very large file sets.
- Add projection to search results.
- Add OS-native credential storage.
- Measure context/token reduction and selection quality on real Desktop Commander workflows.
