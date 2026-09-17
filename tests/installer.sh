#!/bin/sh
# Tests for install.sh, run against throwaway home directories.
#
#   sh tests/installer.sh
#
# The installer edits a file people depend on — ~/.claude/settings.json — so
# every case here is about leaving that file in a state its owner would accept:
# only our entries changed, a backup before any change, nothing changed twice,
# and nothing taken back on uninstall that we did not add.
#
# `claude` is a stub that reports a version, and the repository is cloned from
# this checkout, so nothing here touches the network or a real Claude Code.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Clone from a snapshot of this checkout, including uncommitted changes, so the
# test exercises the tree it lives in.
SOURCE="$WORK/source"
mkdir -p "$SOURCE"
(cd "$ROOT" && git ls-files -co --exclude-standard | tar -cf - -T -) | tar -xf - -C "$SOURCE"
(cd "$SOURCE" && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm snapshot)

pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# A fresh home with a `claude` stub reporting `$1` as its version.
home() {
  H="$WORK/home-$1-$$-$(date +%s%N)"
  mkdir -p "$H/.claude" "$H/stub"
  printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$2" > "$H/stub/claude"
  chmod +x "$H/stub/claude"
}

run() {
  HOME="$H" PATH="$H/stub:/usr/bin:/bin" \
    CLAUDELINGO_REPO="file://$SOURCE" CLAUDELINGO_REF=main \
    sh "$ROOT/install.sh" "$@" > "$H/out" 2>&1
}

json() { python3 -c "import json,sys; d=json.load(open('$H/.claude/settings.json')); print($1)"; }

backups() { ls "$H/.claude/" | grep -c 'claudelingo-backup' || true; }

echo "a fresh install"
home fresh 2.1.274
run
check "clones the plugin" '[ -f "$H/.claude/skills/claudelingo/.claude-plugin/plugin.json" ]'
check "turns function hooks on" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 1 ]'
check "remembers it added the flag" 'grep -q "\"addedFlag\": true" "$H/.claude/skills/claudelingo/.install-state"'
check "makes no backup of a file that did not exist" '[ "$(backups)" = 0 ]'
check "tells you to start claude" 'grep -q "Start Claude Code as usual" "$H/out"'

echo "a settings.json already in use, with the old claudelingo wired in"
home old 2.1.274
cat > "$H/.claude/settings.json" <<'EOF'
{
  "theme": "dark",
  "statusLine": { "type": "command", "command": "\"/opt/claudelingo/bin/claudelingo\" statusline", "refreshInterval": 2 },
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "bash mine.sh session" } ] },
      { "hooks": [ { "type": "command", "command": "claudelingo session-start", "async": true } ] }
    ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "claudelingo hook Stop --source claude" } ] } ],
    "Notification": [ { "hooks": [
      { "type": "command", "command": "claudelingo hook Notification --source claude" },
      { "type": "command", "command": "notify-send done" }
    ] } ]
  },
  "enabledPlugins": { "something@somewhere": true }
}
EOF
cp "$H/.claude/settings.json" "$WORK/original.json"
run
check "removes the old status line, quoted absolute path and all" '[ "$(json "\"statusLine\" in d")" = False ]'
check "removes the old hooks" '! grep -q "claudelingo" "$H/.claude/settings.json"'
check "keeps a hook that is not ours, in the same event" '[ "$(json "d[\"hooks\"][\"SessionStart\"][0][\"hooks\"][0][\"command\"]")" = "bash mine.sh session" ]'
check "keeps a hook that shared a group with ours" '[ "$(json "d[\"hooks\"][\"Notification\"][0][\"hooks\"][0][\"command\"]")" = "notify-send done" ]'
check "drops an event left with nothing in it" '[ "$(json "\"Stop\" in d[\"hooks\"]")" = False ]'
check "leaves every other setting alone" '[ "$(json "d[\"theme\"], d[\"enabledPlugins\"]")" = "dark {'"'"'something@somewhere'"'"': True}" ]'
check "writes one backup, identical to the original" '[ "$(backups)" = 1 ] && cmp -s "$H"/.claude/settings.json.claudelingo-backup-* "$WORK/original.json"'
check "says what it changed" 'grep -q "removed 3 old claudelingo hooks" "$H/out"'

echo "running it again"
run
check "changes nothing the second time" '[ "$(backups)" = 1 ]'
check "updates the plugin in place" 'grep -q "updated to" "$H/out"'

echo "uninstalling"
run --uninstall
check "removes the plugin" '[ ! -d "$H/.claude/skills/claudelingo" ]'
check "takes back the flag it added" '[ "$(json "\"env\" in d")" = False ]'
check "keeps everything else" '[ "$(json "d[\"theme\"]")" = dark ]'
check "says the decks are kept" 'grep -q "decks are kept" "$H/out"'

echo "someone who had already turned function hooks on"
home preset 2.1.274
printf '{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "OTHER": "x" } }\n' > "$H/.claude/settings.json"
run
check "has nothing to change" '[ "$(backups)" = 0 ]'
run --uninstall
check "does not take back a flag it did not add" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 1 ]'

echo "--no-settings"
home nosettings 2.1.274
printf '{ "theme": "light" }\n' > "$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$WORK/untouched.json"
run --no-settings
check "leaves settings.json byte for byte" 'cmp -s "$H/.claude/settings.json" "$WORK/untouched.json"'
check "installs the launcher instead" '[ -x "$H/.local/bin/claude-lingo" ] && grep -q CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 "$H/.local/bin/claude-lingo"'
run --uninstall
check "uninstall removes the launcher" '[ ! -f "$H/.local/bin/claude-lingo" ]'

echo "a settings.json that is not valid JSON"
home broken 2.1.274
printf '{ "theme": "dark", \n' > "$H/.claude/settings.json"
cp "$H/.claude/settings.json" "$WORK/broken.json"
run
check "is left exactly as it was" 'cmp -s "$H/.claude/settings.json" "$WORK/broken.json"'
check "falls back to the launcher" '[ -x "$H/.local/bin/claude-lingo" ]'
check "says why" 'grep -q "not valid JSON" "$H/out"'

echo "a Claude Code too old for function hooks"
home old-claude 2.1.200
run
status=$?
check "refuses" '[ "$status" != 0 ] && grep -q "too old" "$H/out"'
check "installs nothing" '[ ! -d "$H/.claude/skills/claudelingo" ] && [ ! -f "$H/.claude/settings.json" ]'

echo "version comparison"
home versions 2.1.1000
run
check "2.1.1000 is newer than 2.1.271, not older" '[ -d "$H/.claude/skills/claudelingo" ]'
home versions3 3.0.0
run
check "3.0.0 is newer than 2.1.271" '[ -d "$H/.claude/skills/claudelingo" ]'

echo "leftovers from earlier installs"
home leftovers 2.1.274
mkdir -p "$H/.claude/skills/claudelingo-mod/.claude-plugin" "$H/.claude/skills/unrelated/.claude-plugin" "$H/.claudelingo/src/skills/lingo" "$H/.local/bin" "$H/elsewhere/lingo"
printf '{ "name": "claudelingo" }\n' > "$H/.claude/skills/claudelingo-mod/.claude-plugin/plugin.json"
printf '{ "name": "unrelated" }\n' > "$H/.claude/skills/unrelated/.claude-plugin/plugin.json"
ln -s "$H/.claudelingo/src/skills/lingo" "$H/.claude/skills/lingo"
ln -s "$H/elsewhere/lingo" "$H/.claude/skills/other-lingo"
printf '#!/bin/sh\nexec claude --settings "$HOME/.claude/claudelingo-mod-trial.settings.json" "$@"\n' > "$H/.local/bin/claude-lingo"
printf '{}\n' > "$H/.claude/claudelingo-mod-trial.settings.json"
run
check "removes a second copy of the plugin" '[ ! -d "$H/.claude/skills/claudelingo-mod" ]'
check "keeps an unrelated plugin" '[ -d "$H/.claude/skills/unrelated" ]'
check "removes the old /lingo skill link" '[ ! -e "$H/.claude/skills/lingo" ]'
check "keeps a link that is not the old skill" '[ -L "$H/.claude/skills/other-lingo" ]'
check "replaces a launcher that pointed at the removed overlay" '! grep -q claudelingo-mod-trial "$H/.local/bin/claude-lingo" && grep -q "Installed by claudelingo" "$H/.local/bin/claude-lingo"'
check "removes the overlay" '[ ! -f "$H/.claude/claudelingo-mod-trial.settings.json" ]'
check "never touches the old decks" '[ -d "$H/.claudelingo" ]'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
