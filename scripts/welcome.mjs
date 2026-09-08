/**
 * Printed once, right after a global `npm install`.
 *
 * Installing gives you the binary; it does not wire anything into Claude Code.
 * Saying so here is the difference between "it works" and "nothing happened".
 */
const ESC = String.fromCharCode(27);
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;

// Quiet for CI, and for anyone installing this as a dependency of something else.
if (process.env.CI || process.env.npm_config_global !== "true") process.exit(0);

process.stdout.write(
  `\n${bold("claudelingo installed.")} One more step:\n\n` +
    `  ${bold("claudelingo init")}\n\n` +
    `${dim("That wires it into Claude Code and Codex. After that, just open Claude")}\n` +
    `${dim("Code as usual: words appear under your prompt, and the quiz pane opens")}\n` +
    `${dim("itself beside you when you are in tmux.")}\n\n`,
);
