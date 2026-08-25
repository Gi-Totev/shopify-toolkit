#!/usr/bin/env bash
# Install stk: symlink bin/stk into a PATH dir and check dependencies.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN=""
for d in "$HOME/.local/bin" "/usr/local/bin" "$HOME/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then BIN="$d"; break; fi
done
BIN="${BIN:-$HOME/.local/bin}"
mkdir -p "$BIN"

chmod +x "$REPO/bin/stk"
ln -sf "$REPO/bin/stk" "$BIN/stk"
echo "linked: $BIN/stk -> $REPO/bin/stk"

command -v node >/dev/null || echo "WARN: node not found — required to run tools"
command -v fzf  >/dev/null || echo "WARN: fzf not found — needed for the picker (brew install fzf)"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "NOTE: $BIN is not on your PATH. Add to your shell rc:"; echo "      export PATH=\"$BIN:\$PATH\"";;
esac

echo "done. try: stk -h"
