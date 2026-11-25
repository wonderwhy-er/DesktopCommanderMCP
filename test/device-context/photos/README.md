# Photo scenario (ChatGPT via remote, on the test VPS)

An old PHP shop in `~/public_html` with 300 product photos. An "earlier chat" (real DC calls, no AI,
clock shifted) installs sharp, writes `tools/resize.js` and runs it; it crashes on product-0181.jpg
(not an image), so 180 of 300 are resized. With `WEEK=1` the job is 7 days old and ~130 other calls follow it.

- `build.sh` — once: builds the pristine shop (300 generated photos + sharp) in /var/tmp/dctest/photokit/pristine
- `run.sh prep <off|both> <label>` — resets the shop and DC history, replays the earlier chat, restarts the daemon
- then ask ChatGPT (Remote Desktop Commander attached), e.g.
  "last week we started making the photos on my shop smaller but it never finished, can you finish it?"
- `run.sh grade <label>` — calls, resized count, redone files, originals untouched, history call sizes

VPS-specific paths (/var/tmp/dctest, evalkit/grade.mjs, chatgpt/base.jsonl). History call sizes need
DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1 on the daemon.
