# AI-authored activity updates and terminal view

This feature lives in a fork. It does not modify an installed Remote Desktop Commander process.

## Behavior

- The local/stdio MCP server advertises a report_activity tool and default guidance in its initialize.instructions. Users do not need to write a custom prompt to expose the feature.
- A model can call report_activity before an action (phase: plan) and after important results (done, warning, error). These explanations are written by the AI, not inferred.
- The remote-device wrapper receives notifications from its local stdio child, associates the next real tool call with the AI explanation, and updates the screen when execution finishes.
- If the model does not announce an action, a generic fallback based only on the tool name appears, explicitly labeled auto rather than AI.
- Tool arguments, metadata and complete results are no longer printed in the remote-device terminal.
- TTY output uses an ANSI dashboard. Piped output shows compact lines. Set DC_ACTIVITY_UI=off to use compact lines inside a terminal as well.

## Important limitations

MCP initialize.instructions is a hint, **not** a system prompt. Clients can ignore it. Prompt templates exposed through prompts/list are not injected automatically either.

The hosted endpoint at https://mcp.desktopcommander.app/mcp is not open source. It decides which tools are advertised to connected AI models. A new tool in the open-source remote device does not mean that hosted ChatGPT will be offered the tool. **Full AI-authored messages through the hosted endpoint require upstream support or a separately hosted MCP server.** Until then, the device's automatic fallback still displays short, truthful tool statuses.

## Build and tests (isolated development checkout only)

~~~sh
cd /home/tayfur/DesktopCommanderMCP-fork-work
npm ci --ignore-scripts
npm run build
node --test test/activity-ui.test.js test/activity-mcp.smoke.test.js
~~~

The smoke test runs a separate local stdio child with temporary HOME and does not connect to the production Remote Device. Do **not** start this fork in remote mode with an existing saved device identity while the production Remote Device is running.

## Usage example

First AI call (announcement):

~~~json
{"phase":"plan","message":"Proje klasöründeki kaynak dosyaları inceleniyor"}
~~~

Then the AI calls list_directory. The UI associates its status with that message. After the result, the AI may send a done update. Announcements never execute commands or claim execution success.
