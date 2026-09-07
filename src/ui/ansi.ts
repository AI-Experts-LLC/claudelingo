/** Terminal control sequences, built from a char code so no raw ESC bytes sit in source. */
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

export const ansi = {
  reset: `${CSI}0m`,
  dim: `${CSI}2m`,
  bold: `${CSI}1m`,
  green: `${CSI}32m`,
  red: `${CSI}31m`,
  cyan: `${CSI}36m`,
  yellow: `${CSI}33m`,
  clearScreen: `${CSI}2J${CSI}H`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
};

/** Matches any SGR sequence, for width calculations. */
export const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Raw control bytes that arrive on stdin in raw mode. */
export const keys = {
  ctrlC: String.fromCharCode(3),
  backspace: String.fromCharCode(8),
  del: String.fromCharCode(127),
  esc: ESC,
};
