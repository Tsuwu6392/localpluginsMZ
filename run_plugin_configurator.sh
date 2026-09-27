#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js was not found on your PATH."
    echo "Install it from https://nodejs.org and try again."
    read -p "Press Enter to close..."
    exit 1
fi

node plugin_configurator.js
status=$?

if [ $status -ne 0 ]; then
    echo ""
    echo "Plugin Configurator exited with an error - see above."
    read -p "Press Enter to close..."
fi
