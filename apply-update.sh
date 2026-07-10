#!/usr/bin/env bash
set -euo pipefail

ZIP_INPUT="${1:-}"

if [[ -z "$ZIP_INPUT" ]]; then
  echo "Usage: $0 path/to/update.zip"
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "Error: unzip is required but was not found."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Accept either an absolute ZIP path or a path relative to the current shell.
if [[ "$ZIP_INPUT" = /* ]]; then
  ZIP_PATH="$ZIP_INPUT"
else
  ZIP_PATH="$(pwd)/$ZIP_INPUT"
fi

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "Error: Could not find ZIP file: $ZIP_PATH"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
MATCH_FOUND="false"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Project root: $PROJECT_ROOT"
echo "Update ZIP:   $ZIP_PATH"
echo

echo "Unpacking ZIP..."
unzip -q "$ZIP_PATH" -d "$TMP_DIR"

echo "Validating update structure..."

while IFS= read -r file; do
  rel_path="${file#$TMP_DIR/}"

  # Ignore common macOS ZIP artifacts.
  if [[ "$rel_path" == __MACOSX/* ]] || [[ "$(basename "$rel_path")" == ".DS_Store" ]]; then
    continue
  fi

  # Reject unsafe paths.
  if [[ "$rel_path" == /* ]] || [[ "$rel_path" == *".."* ]] || [[ "$rel_path" == .git/* ]]; then
    echo "Error: unsafe path detected in ZIP: $rel_path"
    exit 1
  fi

  if [[ -f "$PROJECT_ROOT/$rel_path" ]]; then
    MATCH_FOUND="true"
    echo "Matched existing project file: $rel_path"
    break
  fi
done < <(find "$TMP_DIR" -type f)

if [[ "$MATCH_FOUND" != "true" ]]; then
  echo "Error: rejected ZIP package."
  echo "No file in the ZIP matched an existing project file at the same relative path."
  echo "This usually means the ZIP does not mirror the project folder structure."
  exit 1
fi

echo
echo "Applying update..."

while IFS= read -r file; do
  rel_path="${file#$TMP_DIR/}"

  # Ignore common macOS ZIP artifacts.
  if [[ "$rel_path" == __MACOSX/* ]] || [[ "$(basename "$rel_path")" == ".DS_Store" ]]; then
    continue
  fi

  target_path="$PROJECT_ROOT/$rel_path"
  mkdir -p "$(dirname "$target_path")"
  cp "$file" "$target_path"

  echo "Updated: $rel_path"
done < <(find "$TMP_DIR" -type f)

echo
echo "Done. Review changes with:"
echo "  git status"
echo "  git diff"
