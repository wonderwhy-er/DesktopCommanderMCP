# Desktop Commander MCP Design Philosophy

Desktop Commander helps AI agents work with files, terminal processes, and development environments. Our design goal is not just to expose valid tool interfaces. It is to help agents complete real user tasks reliably across a changing ecosystem of models and MCP clients.

This document describes the principles behind our public tool interfaces. It is not a complete API reference, a guarantee that every client behaves identically, or a promise that today's interface will never change.

## Design for the agent's whole task

An individual tool call is one step in a larger workflow. A useful tool response should let the agent understand what happened, decide what to do next, and continue safely.

We favor interfaces that are:

- **Understandable:** results explain their meaning without requiring undocumented interpretation.
- **Bounded:** large files and long-running processes do not need to be returned all at once.
- **Actionable:** when another step is needed, the response indicates what that step is.
- **Compatible:** the essential information should reach agents through a broad range of MCP clients.
- **Honest:** an unfinished operation is not reported as complete, and uncertainty is not disguised as success.

We evaluate improvements by their effect on real agent workflows and user experience, not only by the presence of optional fields or abstractions.

## Interoperability is more than protocol compliance

MCP establishes a common protocol, but hosts and models do not always consume tool results in the same way. In practical integrations, some clients emphasize text, some use structured results, and some process both. If the same information appears in both representations, an integration may also show or process it twice.

For this reason, Desktop Commander commonly includes clear, human-readable text that an agent can act on directly. In tools and contexts where structured data is useful, we also provide structured fields. Neither text nor structured output is universally best, and neither representation is guaranteed to behave identically in every host.

Our aim is to preserve the information an agent needs while avoiding unnecessary complexity and redundant output. As the MCP ecosystem evolves, we will continue adjusting that balance.

### Example: a useful response without requiring a particular schema

A file-reading result may begin with a status line like:

```text
[Reading 100 lines from line 0 (total: 5000 lines, 4900 remaining)]
```

The agent can see the section returned, the total size, and how much remains. It can continue with the same `read_file` tool using `offset` and `length`. A programmatic client might benefit from additional structured fields; the text representation is useful to agents that primarily consume readable tool results.

This is different from MCP protocol pagination for listing tools or resources. We choose the form of pagination for a file-reading operation based on that tool's workflow.

## Design results for recovery, not unnecessary interruption

A failed *step* is not always a failed *task*. Agents can often correct a path, refine a search, continue reading, or wait for a process without asking the user to take over.

Just as importantly, not every outcome that requires another action is an error. MCP hosts can display and react to tool errors differently. We aim to describe ordinary workflow states as normal results, while still identifying genuine failures clearly and providing useful recovery information.

### Example: a process is still running

When a command has started but has not finished within the initial wait, `start_process` can return information about the running process. The agent can then call `read_process_output` rather than interpreting the initial wait as a failed command or starting a second copy.

### Example: a large response needs another read

If a file or process produces more output than can reasonably be returned in one call, the tool can explain what was shown and how to request more. Reaching an output boundary is an expected workflow condition, not evidence that reading failed.

### Example: an actual operation fails

A missing file or rejected operation should not be silently represented as success. MCP tool errors can use `isError: true`, accompanied by a useful message. Where appropriate, the message should help the agent identify a safe next step, such as checking a path or correcting a command.

Our guiding distinction is between **completed operations**, **operations that need another step**, and **genuine failures**. Error flags and response text should communicate that distinction accurately; they should not merely make a client UI appear calmer.

## Favor predictable, scoped changes

An agent editing a project should have ways to make limited changes and notice when the file does not match its expectations.

For example, `edit_block` can replace specific existing content and check the expected number of replacements. That is often preferable to rewriting an entire file for a small change. Agents should still inspect relevant content before making consequential edits and use version control or other safeguards where appropriate.

A precise edit is not the same as a general revision-locking transaction. Desktop Commander does not claim that all file operations are atomic or immune to concurrent changes.

## Make remote execution status explicit

Remote operations add network delays and uncertainty that do not arise in exactly the same way in a local tool call.

When a Remote call continues beyond its initial response window, it can return a `call_id`. The agent can use `get_tool_result` to check the same operation later instead of immediately submitting a second request.

Remote also includes protections against duplicate *delivery* of an individual call. That differs from deduplicating two separately submitted calls that happen to contain the same arguments. Desktop Commander does not promise general-purpose idempotency keys or exactly-once execution for every side-effecting operation.

If the outcome of a write or command is uncertain, agents should check its recorded status or verify the resulting state before attempting it again. This is especially important for operations that append data or start processes.

## Improve based on observed agent behavior

We expect agent hosts, models, and MCP capabilities to keep changing. Accordingly, we treat design choices as trade-offs to revisit, not fixed rules.

When considering an interface change, we ask whether it helps agents understand results, complete tasks, recover from interruptions, and avoid unintended side effects across supported environments. Structured output, additional metadata, and richer safeguards can all be valuable when they demonstrably serve those goals.

We welcome reproducible reports of workflows that fail or behave unexpectedly. They are especially useful when they identify the MCP client, tool, expected behavior, and observed result. Please use [GitHub issues](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues) for actionable product problems.

## Further reading

- [Desktop Commander README](../README.md) — installation, tools, and usage examples
- [Frequently Asked Questions](../FAQ.md) — practical workflows and common questions
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — protocol-level tool results and errors
- [MCP resources specification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) — protocol-level resource listing and pagination

Our measure of a good tool interface is whether it helps a real agent finish the user's task safely, clearly, and reliably.
