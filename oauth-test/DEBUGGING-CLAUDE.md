Quick question: In Claude.ai when you add the MCP server, what "Transport" option are you selecting?

- **HTTP (POST)** / **Streamable HTTP**?
- **SSE (Server-Sent Events)**?

The GET request to /mcp suggests Claude might be trying to use SSE, which requires a different server implementation (keeps connection open and streams events).

If you selected "Streamable HTTP", try this:
1. Remove the server from Claude
2. Re-add it and make sure you select **"HTTP"** or **"Streamable HTTP"** (not SSE)

If it's already set to HTTP/Streamable HTTP, then we need to debug why Claude isn't calling tools/list.