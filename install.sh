#!/bin/sh
# claudelingo installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
#
# Uninstall:
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall
#
# What it does, all of it reversible with --uninstall:
#
#   1. Clones claudelingo into ~/.claude/skills/claudelingo, where Claude Code
#      loads it as a plugin. Re-running updates it.
#   2. Turns on function hooks, the early-access Claude Code feature mods run on,
#      by adding CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 to the "env" block of
#      ~/.claude/settings.json. A backup is written first.
#   3. If the older, pre-mod claudelingo is wired into that file (its status
#      line and hooks), removes those entries so you do not get two claudelingos
#      writing two decks. Your old progress is imported on first run.
#
# Pass --no-settings to leave settings.json alone; you then start Claude Code
# with `claude-lingo` instead of `claude`.
#
# Set CLAUDELINGO_REPO / CLAUDELINGO_REF to install from a fork or a branch.

set -eu

REPO="${CLAUDELINGO_REPO:-https://github.com/AI-Experts-LLC/claudelingo}"
REF="${CLAUDELINGO_REF:-main}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DIR="$CLAUDE_DIR/skills/claudelingo"
SETTINGS="$CLAUDE_DIR/settings.json"
STATE="$DIR/.install-state"
BIN="$HOME/.local/bin"
LAUNCHER="$BIN/claude-lingo"
MIN_VERSION="2.1.271"

say() { printf '%s\n' "$*"; }
step() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# `1.2.10` >= `1.2.9`, without relying on `sort -V`, which older macOS lacks.
version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".")
    for (i = 1; i <= 3; i++) {
      if ((h[i] + 0) > (n[i] + 0)) exit 0
      if ((h[i] + 0) < (n[i] + 0)) exit 1
    }
    exit 0
  }'
}

have_python() {
  command -v python3 >/dev/null 2>&1 && python3 -c 'import json' >/dev/null 2>&1
}

# Every settings.json change goes through here: real JSON in, real JSON out,
# a backup before the first write, and a report of exactly what changed.
edit_settings() {
  python3 - "$SETTINGS" "$1" "$STATE" <<'PY'
import json, os, re, shutil, sys, time

path, mode, state_path = sys.argv[1], sys.argv[2], sys.argv[3]
FLAG = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"

try:
    with open(path) as f:
        text = f.read()
    settings = json.loads(text) if text.strip() else {}
except FileNotFoundError:
    settings = {}
except ValueError as error:
    print(f"settings.json is not valid JSON ({error}); leaving it alone", file=sys.stderr)
    sys.exit(3)

if not isinstance(settings, dict):
    print("settings.json is not a JSON object; leaving it alone", file=sys.stderr)
    sys.exit(3)

before = json.dumps(settings, sort_keys=True)
changes = []

def state():
    try:
        with open(state_path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}

if mode == "install":
    env = settings.setdefault("env", {})
    if not isinstance(env, dict):
        print('settings.json "env" is not an object; leaving it alone', file=sys.stderr)
        sys.exit(3)

    added_flag = False
    if env.get(FLAG) != "1":
        added_flag = FLAG not in env
        env[FLAG] = "1"
        changes.append(f"set env.{FLAG} = 1")

    # The pre-mod claudelingo: `claudelingo statusline` and six
    # `claudelingo hook <Event>` / `claudelingo session-start` entries. The
    # command may carry an absolute, quoted path to the binary.
    old = re.compile(r'claudelingo"?\s+(hook|session-start|statusline|notify)\b')

    line = settings.get("statusLine")
    if isinstance(line, dict) and old.search(str(line.get("command", ""))):
        del settings["statusLine"]
        changes.append("removed the old claudelingo status line")

    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        removed = 0
        for event in list(hooks):
            groups = hooks[event]
            if not isinstance(groups, list):
                continue
            kept_groups = []
            for group in groups:
                inner = group.get("hooks") if isinstance(group, dict) else None
                if not isinstance(inner, list):
                    kept_groups.append(group)
                    continue
                kept = [h for h in inner if not (isinstance(h, dict) and old.search(str(h.get("command", ""))))]
                removed += len(inner) - len(kept)
                if kept:
                    group["hooks"] = kept
                    kept_groups.append(group)
            if kept_groups:
                hooks[event] = kept_groups
            else:
                del hooks[event]
        if not hooks:
            del settings["hooks"]
        if removed:
            changes.append(f"removed {removed} old claudelingo hook{'s' if removed != 1 else ''}")

    # Remember whether the flag was ours, so uninstall only takes back what it gave.
    previous = state()
    remembered = {"addedFlag": previous.get("addedFlag", False) or added_flag}
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w") as f:
        json.dump(remembered, f)

elif mode == "uninstall":
    if state().get("addedFlag"):
        env = settings.get("env")
        if isinstance(env, dict) and FLAG in env:
            del env[FLAG]
            if not env:
                del settings["env"]
            changes.append(f"removed env.{FLAG}")

if json.dumps(settings, sort_keys=True) != before:
    if os.path.exists(path):
        backup = f"{path}.claudelingo-backup-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(path, backup)
        changes.append(f"backup: {backup}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".claudelingo-tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)

for change in changes:
    print(change)
PY
}

install_launcher() {
  mkdir -p "$BIN"
  cat > "$LAUNCHER" <<'LAUNCH'
#!/bin/sh
# Claude Code with function hooks on, for claudelingo. Installed by claudelingo.
exec env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude "$@"
LAUNCH
  chmod +x "$LAUNCHER"
}

# Things earlier installs of claudelingo left behind that would now get in the
# way: a second copy of the plugin would draw a second band, and the old /lingo
# skill would compete with the mod's /lingo.
remove_leftovers() {
  legacy="$CLAUDE_DIR/skills/claudelingo-mod"
  if [ -f "$legacy/.claude-plugin/plugin.json" ] && grep -q '"name": *"claudelingo"' "$legacy/.claude-plugin/plugin.json"; then
    rm -rf "$legacy"
    step "removed an older copy at $legacy"
  fi

  skill="$CLAUDE_DIR/skills/lingo"
  if [ -L "$skill" ] && readlink "$skill" | grep -q '\.claudelingo'; then
    rm -f "$skill"
    step "removed the old /lingo skill link"
  fi

  # An earlier hand-made launcher ran Claude Code with a settings overlay this
  # removes. Replace it with the current one rather than leave it pointing at a
  # file that is no longer there.
  if [ -f "$LAUNCHER" ] && grep -q 'claudelingo-mod-trial' "$LAUNCHER"; then
    install_launcher
    step "updated $LAUNCHER"
  fi

  if [ -f "$CLAUDE_DIR/claudelingo-mod-trial.settings.json" ]; then
    rm -f "$CLAUDE_DIR/claudelingo-mod-trial.settings.json"
  fi
}

uninstall() {
  say "Uninstalling claudelingo"

  if [ -f "$SETTINGS" ] && [ -f "$STATE" ]; then
    if have_python; then
      edit_settings uninstall | while IFS= read -r line; do step "$line"; done
    else
      warn "python3 not found; remove env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS from $SETTINGS by hand if you want it gone"
    fi
  fi

  if [ -d "$DIR" ]; then
    rm -rf "$DIR"
    step "removed $DIR"
  fi

  if [ -f "$LAUNCHER" ] && grep -q 'Installed by claudelingo' "$LAUNCHER"; then
    rm -f "$LAUNCHER"
    step "removed $LAUNCHER"
  fi

  say ""
  say "Your decks are kept, in $CLAUDE_DIR/plugins/store/claudelingo_*.json."
  say "Reinstall any time and they will be there."
}

main() {
  mode=install
  use_settings=1

  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall ;;
      --no-settings) use_settings=0 ;;
      -h|--help)
        # `$0` is just "sh" when piped from curl, so the usage lives here.
        say "usage: install.sh [--uninstall] [--no-settings]"
        say "  --uninstall    remove claudelingo (your decks are kept)"
        say "  --no-settings  leave settings.json alone; start with claude-lingo instead"
        exit 0
        ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  if [ "$mode" = uninstall ]; then
    uninstall
    exit 0
  fi

  say "Installing claudelingo"

  command -v git >/dev/null 2>&1 || die "git is required"
  command -v claude >/dev/null 2>&1 || die "Claude Code is required: https://docs.claude.com/en/docs/claude-code"

  version=$(claude --version 2>/dev/null | awk '{print $1}')
  if [ -n "$version" ] && ! version_at_least "$version" "$MIN_VERSION"; then
    die "Claude Code $version is too old; claudelingo needs $MIN_VERSION or newer, which is on the latest release channel (the stable channel may not have reached it yet)"
  fi

  mkdir -p "$CLAUDE_DIR/skills"

  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$DIR" reset --quiet --hard FETCH_HEAD
    step "updated to $(git -C "$DIR" log --oneline -1)"
  else
    rm -rf "$DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
    step "installed $(git -C "$DIR" log --oneline -1)"
  fi

  remove_leftovers

  if [ "$use_settings" = 1 ] && have_python; then
    if output=$(edit_settings install); then
      [ -n "$output" ] && printf '%s\n' "$output" | while IFS= read -r line; do step "$line"; done
      say ""
      say "Done. Start Claude Code as usual:  claude"
    else
      warn "left settings.json unchanged (see above)"
      use_settings=0
    fi
  elif [ "$use_settings" = 1 ]; then
    warn "python3 not found, so settings.json was not changed"
    use_settings=0
  fi

  if [ "$use_settings" = 0 ]; then
    install_launcher
    step "installed $LAUNCHER"
    say ""
    case ":$PATH:" in
      *":$BIN:"*) say "Done. Start Claude Code with:  claude-lingo" ;;
      *) say "Done. Start Claude Code with:  $LAUNCHER   (or add $BIN to your PATH)" ;;
    esac
  fi

  say ""
  say "Start a task and a card appears above your prompt; press the digit beside"
  say "your answer. Press 1 on the idle band for a quiz. /lingo shows the rest."
  say "Uninstall: curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall"
}

main "$@"
