#!/bin/sh
# claudelingo installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
#
# Clones, builds and links the CLI, then wires it into Claude Code. It does the
# build itself rather than leaning on npm lifecycle scripts, because newer npm
# blocks those by default and a blocked build leaves an installed-but-broken
# command behind.
#
# Nothing here needs an API key: claudelingo runs its model requests through the
# Claude Code session you already have.
set -eu

REPO="${CLAUDELINGO_REPO:-AI-Experts-LLC/claudelingo}"
BRANCH="${CLAUDELINGO_BRANCH:-main}"
SRC="${CLAUDELINGO_SRC:-$HOME/.claudelingo/src}"
REMOTE="${CLAUDELINGO_REMOTE:-https://github.com/${REPO}.git}"

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { printf 'claudelingo: %s\n' "$*" >&2; exit 1; }

command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 20.11 or newer is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || die "npm is required"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=11)?0:1)' \
  || die "Node.js 20.11 or newer is required (found $(node -v))"

if ! command -v claude >/dev/null 2>&1; then
  warn "note: the 'claude' command was not found. claudelingo still works, but memory"
  warn "      hooks and pack generation run through Claude Code, so they need it."
fi

if [ -d "$SRC/.git" ]; then
  say "Updating claudelingo in $SRC ..."
  # Fetch into a local ref: a bare `fetch --depth 1 origin <branch>` leaves
  # refs/remotes/origin/<branch> untouched, so the reset below would fail
  # whenever CLAUDELINGO_BRANCH differs from the branch first cloned.
  git -C "$SRC" fetch --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >/dev/null \
    || die "could not fetch $BRANCH from $REMOTE"
  git -C "$SRC" reset --hard "refs/remotes/origin/$BRANCH" >/dev/null \
    || die "could not check out $BRANCH"
else
  say "Fetching claudelingo into $SRC ..."
  mkdir -p "$(dirname "$SRC")"
  rm -rf "$SRC"
  git clone --depth 1 --branch "$BRANCH" "$REMOTE" "$SRC" >/dev/null \
    || die "could not clone $REMOTE (is the repository private? try: gh repo clone $REPO \"$SRC\")"
fi

say "Building ..."
# Every step reports: a `curl | sh` installer that aborts silently is the worst
# possible failure mode, and stderr is left attached on purpose.
( cd "$SRC" && npm install --silent --no-audit --no-fund >/dev/null ) \
  || die "npm install failed in $SRC"
( cd "$SRC" && npm run build >/dev/null ) \
  || die "the build failed in $SRC"
[ -f "$SRC/dist/cli.js" ] || die "the build produced no $SRC/dist/cli.js"

# Link the command somewhere on PATH, preferring a directory the user owns.
BIN=""
for candidate in "${CLAUDELINGO_BIN:-}" "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
  [ -n "$candidate" ] || continue
  mkdir -p "$candidate" 2>/dev/null || continue
  if [ -w "$candidate" ]; then BIN="$candidate"; break; fi
done
[ -n "$BIN" ] || die "no writable bin directory found; set CLAUDELINGO_BIN to one"

ln -sf "$SRC/dist/cli.js" "$BIN/claudelingo" || die "could not link into $BIN"
chmod +x "$SRC/dist/cli.js" || die "could not make $SRC/dist/cli.js executable"
say "Linked $BIN/claudelingo"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn ""; warn "note: $BIN is not on your PATH. Add this to your shell profile:"; warn "      export PATH=\"$BIN:\$PATH\"" ;;
esac

say "Wiring it into Claude Code and Codex ..."
"$BIN/claudelingo" init || die "claudelingo init failed; the command is installed at $BIN/claudelingo"

say ""
say "Done. Open Claude Code as usual."
