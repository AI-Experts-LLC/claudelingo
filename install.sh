#!/bin/sh
# claudelingo installer, for people who would rather paste a curl command.
#
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/AI-Experts-LLC/claudelingo/main/install.sh | sh -s -- --uninstall
#
# It hands straight off to the npm package, which does the actual work, so there
# is one installer and not two that can drift apart. This is the same as:
#
#   npx claudelingo@latest install
#
# Options: --uninstall, --no-settings. See `npx claudelingo help`.

set -eu

main() {
  package="${CLAUDELINGO_PACKAGE:-claudelingo@latest}"
  command=install
  passthrough=""

  for arg in "$@"; do
    case "$arg" in
      --uninstall) command=uninstall ;;
      --no-settings) passthrough="--no-settings" ;;
      -h|--help)
        echo "usage: install.sh [--uninstall] [--no-settings]"
        echo "  the same as: npx claudelingo@latest install   (or uninstall)"
        exit 0
        ;;
      *) echo "unknown option: $arg" >&2; exit 1 ;;
    esac
  done

  if ! command -v npx >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
    echo "claudelingo needs Node.js 18 or newer to install: https://nodejs.org" >&2
    exit 1
  fi

  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -lt 18 ]; then
    echo "claudelingo needs Node.js 18 or newer to install (you have $(node --version))" >&2
    exit 1
  fi

  # Run from a neutral directory: npx resolves packages against the current one,
  # and a curl install can start inside any project, including one with its own
  # `claudelingo` dependency. stdin is this script when piped from curl, so
  # nothing downstream should read it.
  cd "${TMPDIR:-/tmp}"

  if [ "$command" = uninstall ]; then
    exec npx --yes --package="$package" claudelingo uninstall </dev/null
  fi

  # shellcheck disable=SC2086
  exec npx --yes --package="$package" claudelingo install $passthrough </dev/null
}

# Wrapped in a function so a download cut off partway through runs nothing.
main "$@"
