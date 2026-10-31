/**
 * node -i (Node.js 24) run as start_process runs it (piped stdio), captured
 * from real sessions on Windows 11 (Node 24.18.0) and macOS 26 (Node 24.15.0):
 * everything it wrote, byte for byte (all to stdout; stderr stayed empty; no
 * paths appear). Node 24 prompts "| " for more of a statement, where earlier
 * versions prompted "... ". It doesn't echo the input, so the "| " follows the
 * "> " it was typed at on the same line.
 *
 * Each session: its banner and first prompt, then [input sent, what node -i
 * wrote after it], in the order sent. The exchanges were the same on both.
 */
const exchanges = [
  ['function f() {', '| '],
  ['  return 1;\n}', '| undefined\n> '],
  ['f()', '1\n> '],
  ['function g() {\n  return 2;\n}\ng()', '| | undefined\n> 2\n> '],
  ["console.log('| a | b |\\n|---|---|\\n| 1 | 2 |')", '| a | b |\n|---|---|\n| 1 | 2 |\nundefined\n> '],
];

export const NODE_24_SESSIONS = [
  ['Windows 11, Node 24.18.0', 'Welcome to Node.js v24.18.0.\nType ".help" for more information.\n> ', exchanges],
  ['macOS 26, Node 24.15.0', 'Welcome to Node.js v24.15.0.\nType ".help" for more information.\n> ', exchanges],
];
