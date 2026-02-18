#!/usr/bin/env bash
# Cocktail MOBO – start script (works on macOS, Linux, and MSYS2 / Git Bash on Windows)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"

echo "============================================"
echo " Cocktail MOBO Optimizer – Starting server"
echo "============================================"
echo ""

# Install / upgrade Python deps
echo "Installing dependencies…"
pip install -r "$BACKEND/requirements.txt" --quiet

echo ""
echo "Starting FastAPI server on http://localhost:8000"
echo "Open your browser to http://localhost:8000"
echo "Press Ctrl+C to stop."
echo ""

cd "$BACKEND"
python main.py
