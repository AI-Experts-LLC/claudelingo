#!/bin/sh
# Tests for the installer (`claudelingo install`), run against throwaway homes.
#
#   sh tests/installer.sh
#
# The installer edits a file people depend on — ~/.claude/settings.json — so
# every case here is about leaving that file in a state its owner would accept:
# only our entries changed, a backup before any change, nothing changed twice,
# and nothing taken back on uninstall that we did not add.
#
# `claude` is a stub that reports a version, and the installer runs from this
# checkout, so nothing here touches the network or a real Claude Code. The last
# group packs the real npm tarball and installs from that, which is the only way
# to know the published package carries everything the plugin needs.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
homes=0

ok() { pass=$((pass + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# A fresh home with a `claude` stub reporting `$1` as its version.
home() {
  homes=$((homes + 1))
  H="$WORK/home-$homes-$1"
  mkdir -p "$H/.claude" "$H/stub"
  printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$2" > "$H/stub/claude"
  chmod +x "$H/stub/claude"
}

NODE_DIR=$(dirname "$(command -v node)")

# `run` is `claudelingo install`; `run --uninstall` is `claudelingo uninstall`.
run() {
  cmd=install
  if [ "${1:-}" = --uninstall ]; then cmd=uninstall; shift; fi
  HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" \
    node "$ROOT/cli/claudelingo.mjs" "$cmd" "$@" > "$H/out" 2>&1
}

json() { python3 -c "import json,sys; d=json.load(open('$H/.claude/settings.json')); print($1)"; }

backups() { ls "$H/.claude/" | grep -c 'claudelingo-backup' || true; }

echo "a fresh install"
home fresh 2.1.274
run
check "clones the plugin" '[ -f "$H/.claude/skills/claudelingo/.claude-plugin/plugin.json" ]'
check "turns function hooks on" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 1 ]'
check "remembers the flag was not there before" 'grep -Eq "\"present\": ?false" "$H/.claude/skills/claudelingo/.install-state"'
check "creates a new settings.json readable only by you" '[ "$(stat -c %a "$H/.claude/settings.json" 2>/dev/null || stat -f %Lp "$H/.claude/settings.json")" = 600 ]'
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
check "writes one backup, identical to the original" '[ "$(backups)" = 1 ] && cmp -s "$H/.claude/settings.json.claudelingo-backup" "$WORK/original.json"'
check "says what it changed" 'grep -q "removed 3 old claudelingo hooks" "$H/out"'

echo "running it again"
run
check "changes nothing the second time" '[ "$(backups)" = 1 ]'
check "updates the plugin in place" 'grep -q "updated $H/.claude/skills/claudelingo" "$H/out"'

echo "uninstalling"
run --uninstall
check "keeps the first backup, which holds the original" 'cmp -s "$H/.claude/settings.json.claudelingo-backup" "$WORK/original.json"'
check "writes its own backup beside it rather than over it" '[ -f "$H/.claude/settings.json.claudelingo-backup-2" ]'
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

echo "commands that only mention claudelingo"
home mentions 2.1.274
cat > "$H/.claude/settings.json" <<'EOF'
{
  "statusLine": { "type": "command", "command": "sh -c 'claudelingo statusline; ~/bin/mygit-status'" },
  "hooks": {
    "Stop": [ { "hooks": [
      { "type": "command", "command": "~/bin/notify-claudelingo hook-done" },
      { "type": "command", "command": "~/bin/notify-claudelingo hook Stop" },
      { "type": "command", "command": "claudelingo stats" },
      { "type": "command", "command": "echo claudelingo hook Stop" },
      { "type": "command", "command": "claudelingo hook Stop --source claude" }
    ] } ]
  }
}
EOF
run
check "keeps a status line that runs claudelingo among other things" '[ "$(json "\"statusLine\" in d")" = True ]'
check "keeps a script whose name merely contains claudelingo" 'grep -q "notify-claudelingo hook-done" "$H/.claude/settings.json"'
check "keeps a command that only says claudelingo" 'grep -q "echo claudelingo hook Stop" "$H/.claude/settings.json"'
check "keeps a real verb run by a different program" 'grep -q "notify-claudelingo hook Stop" "$H/.claude/settings.json"'
check "keeps claudelingo itself run with a verb that was never a hook" 'grep -q "\"claudelingo stats\"" "$H/.claude/settings.json"'
check "still removes the one that is really the old claudelingo" '! grep -q "\"claudelingo hook Stop --source claude\"" "$H/.claude/settings.json"'
check "counts only what it actually removed" 'grep -q "removed 1 old claudelingo hook$" "$H/out"'

echo "file permissions"
home perms 2.1.274
printf '{ "env": { "ANTHROPIC_API_KEY": "sk-secret" } }\n' > "$H/.claude/settings.json"
chmod 600 "$H/.claude/settings.json"
(umask 022; run)
check "keeps a private settings.json private" '[ "$(stat -c %a "$H/.claude/settings.json" 2>/dev/null || stat -f %Lp "$H/.claude/settings.json")" = 600 ]'
check "leaves no temporary file behind" '! ls -a "$H/.claude" | grep -q claudelingo-tmp'

# 600 alone cannot tell "preserved" from "happened to match": the temporary file
# is created private, so a writer that forgot to copy the mode would still pass
# above. A mode that is not 600 shows the difference.
home perms-shared 2.1.274
printf '{ "theme": "dark" }\n' > "$H/.claude/settings.json"
chmod 640 "$H/.claude/settings.json"
run
check "keeps whatever mode the file had, not just a private one" '[ "$(stat -c %a "$H/.claude/settings.json" 2>/dev/null || stat -f %Lp "$H/.claude/settings.json")" = 640 ]'

echo "a settings.json that is a symlink"
home symlink 2.1.274
mkdir -p "$H/dotfiles"
printf '{ "theme": "dark" }\n' > "$H/dotfiles/settings.json"
ln -s "$H/dotfiles/settings.json" "$H/.claude/settings.json"
run
check "is still a symlink afterwards" '[ -L "$H/.claude/settings.json" ]'
check "has the change written into the file it points at" 'grep -q CLAUDE_CODE_ENABLE_FUNCTION_HOOKS "$H/dotfiles/settings.json"'
check "keeps the backup beside the real file" '[ -f "$H/dotfiles/settings.json.claudelingo-backup" ]'

echo "a settings.json that cannot be written"
home readonly 2.1.274
mkdir -p "$H/store"
printf '{ "theme": "dark" }\n' > "$H/store/settings.json"
chmod 444 "$H/store/settings.json"
ln -s "$H/store/settings.json" "$H/.claude/settings.json"
cp "$H/store/settings.json" "$WORK/readonly.json"
run
check "is left alone" 'cmp -s "$H/store/settings.json" "$WORK/readonly.json" && [ -L "$H/.claude/settings.json" ]'
check "falls back to the launcher" '[ -x "$H/.local/bin/claude-lingo" ]'
check "does not record a change it did not make" '! grep -q "\"flag\"" "$H/.claude/skills/claudelingo/.install-state" 2>/dev/null'
check "says why" 'grep -q "not writable" "$H/out"'

home readonly-dir 2.1.274
mkdir -p "$H/locked"
printf '{ "theme": "dark" }\n' > "$H/locked/settings.json"
chmod 555 "$H/locked"
ln -s "$H/locked/settings.json" "$H/.claude/settings.json"
cp "$H/locked/settings.json" "$WORK/locked.json"
run
chmod 755 "$H/locked"
check "leaves a writable file in a directory it cannot write alone" 'cmp -s "$H/locked/settings.json" "$WORK/locked.json" && [ -x "$H/.local/bin/claude-lingo" ]'
check "says why, instead of a traceback" 'grep -q "is not writable" "$H/out" && ! grep -q Traceback "$H/out"'

echo "someone who had turned function hooks off"
home disabled 2.1.274
printf '{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "0" } }\n' > "$H/.claude/settings.json"
run
check "turns them on" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 1 ]'
run --uninstall
check "puts back the value that was there, not nothing" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 0 ]'

home changed-mind 2.1.274
run
python3 -c "import json; p='$H/.claude/settings.json'; d=json.load(open(p)); d['env']['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']='0'; json.dump(d, open(p,'w'))"
run
run --uninstall
check "restores what the latest install found, not the first" '[ "$(json "d[\"env\"][\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\"]")" = 0 ]'

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
home not-ours 2.1.274
mkdir -p "$H/.claude/skills/claudelingo-mod/.claude-plugin"
printf '{ "name": "someone-elses-plugin" }\n' > "$H/.claude/skills/claudelingo-mod/.claude-plugin/plugin.json"
run
check "keeps a folder called claudelingo-mod that holds a different plugin" '[ -d "$H/.claude/skills/claudelingo-mod" ]'

echo "the older claudelingo, still wired into someone's settings"
home legacy-calls 2.1.274
out=$(HOME="$H" PATH="$NODE_DIR:/usr/bin:/bin" node "$ROOT/cli/claudelingo.mjs" statusline; echo "exit=$?")
check "answers its status line with nothing, rather than text in their status line" '[ "$out" = "exit=0" ]'
out=$(HOME="$H" PATH="$NODE_DIR:/usr/bin:/bin" node "$ROOT/cli/claudelingo.mjs" hook Stop --source claude; echo "exit=$?")
check "answers its hooks silently, rather than an error on every turn" '[ "$out" = "exit=0" ]'

echo "status"
home status 2.1.274
HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" node "$ROOT/cli/claudelingo.mjs" status > "$H/out" 2>&1
check "says not ready before installing, and exits non-zero" '[ $? != 0 ] || grep -q "Not ready" "$H/out"'
run
HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" node "$ROOT/cli/claudelingo.mjs" status > "$H/out" 2>&1
status=$?
check "says ready once installed" '[ "$status" = 0 ] && grep -q "Ready." "$H/out" && grep -q "function hooks        on" "$H/out"'

echo "the published package"
PACK="$WORK/pack"
mkdir -p "$PACK"
(cd "$ROOT" && npm pack --silent --pack-destination "$PACK" >/dev/null 2>&1)
TARBALL=$(ls "$PACK"/claudelingo-*.tgz 2>/dev/null | head -1)
check "packs" '[ -n "$TARBALL" ] && [ -f "$TARBALL" ]'

home npx 2.1.274
(cd "$H" && HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" npm_config_cache="$WORK/npm-cache" \
  npx --yes --package="$TARBALL" claudelingo install > "$H/out" 2>&1)
check "installs through npx from the tarball" 'grep -q "Done. Start Claude Code as usual" "$H/out"'
check "carries the plugin manifest" '[ -f "$H/.claude/skills/claudelingo/.claude-plugin/plugin.json" ]'
check "carries every hooks module the manifest names" '[ -f "$H/.claude/skills/claudelingo/hooks/register.ts" ] && [ -f "$H/.claude/skills/claudelingo/hooks/views/band.tsx" ] && [ -f "$H/.claude/skills/claudelingo/hooks/packs/es.ts" ]'
check "does not copy the installer into the plugin" '[ ! -d "$H/.claude/skills/claudelingo/cli" ]'
check "ships no tests" '! tar -tzf "$TARBALL" | grep -q "package/tests/"'

home curl 2.1.274
HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" npm_config_cache="$WORK/npm-cache" CLAUDELINGO_PACKAGE="$TARBALL" \
  sh -c "cat '$ROOT/install.sh' | sh" > "$H/out" 2>&1
check "the curl command hands off to the package and installs" '[ -f "$H/.claude/skills/claudelingo/.claude-plugin/plugin.json" ] && grep -q "Done." "$H/out"'
HOME="$H" PATH="$H/stub:$NODE_DIR:/usr/bin:/bin" npm_config_cache="$WORK/npm-cache" CLAUDELINGO_PACKAGE="$TARBALL" \
  sh -c "cat '$ROOT/install.sh' | sh -s -- --uninstall" > "$H/out" 2>&1
check "and uninstalls the same way" '[ ! -d "$H/.claude/skills/claudelingo" ]'

home no-node 2.1.274
mkdir -p "$WORK/empty"
HOME="$H" PATH="$H/stub:$WORK/empty" /bin/sh "$ROOT/install.sh" > "$H/out" 2>&1
check "says Node is needed when there is none" 'grep -q "needs Node.js 18" "$H/out"'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
