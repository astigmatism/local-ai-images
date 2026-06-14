#!/usr/bin/env bash

set -euo pipefail

PROJECT_NAME="local-ai-images"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
ARCHIVE_NAME="${PROJECT_NAME}-${TIMESTAMP}.zip"

DEST_DIR="${1:-$HOME/Desktop}"
DEST_DIR="${DEST_DIR/#\~/$HOME}"

mkdir -p "$DEST_DIR"

ARCHIVE_PATH="${DEST_DIR%/}/${ARCHIVE_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

zip -r "$ARCHIVE_PATH" . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "public/build/build.js.map" \
  -x "*.log" \
  -x "npm-debug.log*" \
  -x "yarn-debug.log*" \
  -x "yarn-error.log*" \
  -x ".DS_Store" \
  -x "coverage/*" \
  -x ".nyc_output/*" \
  -x "dist/*" \
  -x "build/*" \
  -x "tmp/*" \
  -x "temp/*" \
  -x ".env" \
  -x ".env.*" \
  -x "${ARCHIVE_NAME}"

echo "Created archive:"
echo "$ARCHIVE_PATH"
