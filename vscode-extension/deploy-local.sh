#!/usr/bin/env bash
# Quick deploy to installed VSCode extension for local testing (no VSIX reinstall needed)
EXT_DIR="/d/Users/SriRama.Bonthu/.vscode/extensions/naveenbonthu9.promoter-2.0.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cp "$SCRIPT_DIR/runner.bundle.js" "$EXT_DIR/runner.bundle.js" && echo "✓ runner.bundle.js"
cp "$SCRIPT_DIR/webview/index.html" "$EXT_DIR/webview/index.html" && echo "✓ webview/index.html"
cp "$SCRIPT_DIR/dist/panel.js" "$EXT_DIR/dist/panel.js" && echo "✓ dist/panel.js"
cp "$SCRIPT_DIR/dist/extension.js" "$EXT_DIR/dist/extension.js" && echo "✓ dist/extension.js"

echo ""
echo "Done — reload VSCode window (Ctrl+Shift+P → Developer: Reload Window)"
