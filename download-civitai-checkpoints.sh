#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${MANIFEST:-./civitai-checkpoint-selection.json}"
DEST_DIR="${DEST_DIR:-}"
DRY_RUN="${DRY_RUN:-false}"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "Manifest not found: ${MANIFEST}" >&2
  exit 1
fi

if [[ -z "${DEST_DIR}" ]]; then
  DEST_DIR="$(python3 - "${MANIFEST}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

print(data.get("destination") or "")
PY
)"
fi

if [[ -z "${DEST_DIR}" ]]; then
  echo "Destination directory is empty. Set DEST_DIR or destination in manifest." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

headers=(
  -H "Accept: application/octet-stream"
  -A "local-ai-images-civitai-downloader/0.1"
)

if [[ -n "${CIVITAI_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${CIVITAI_API_TOKEN}")
fi

plan_file="$(mktemp)"
trap 'rm -f "${plan_file}"' EXIT

python3 - "${MANIFEST}" > "${plan_file}" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])

with manifest_path.open("r", encoding="utf-8") as f:
    data = json.load(f)

for item in data.get("items", []):
    file_name = Path(str(item["file_name"])).name
    if not file_name or file_name in {".", ".."}:
        raise SystemExit(f"Unsafe file name: {item.get('file_name')!r}")

    download_url = item.get("download_url")
    sha256 = item.get("sha256")

    if not download_url:
        raise SystemExit(f"Missing download_url for {file_name}")
    if not sha256:
        raise SystemExit(f"Missing sha256 for {file_name}")

    model_name = str(item.get("model_name") or "")
    model_id = str(item.get("model_id") or "")
    version_id = str(item.get("version_id") or "")
    model_url = str(item.get("model_url") or "")

    print("\t".join([
        file_name,
        sha256.upper(),
        download_url,
        model_name,
        model_id,
        version_id,
        model_url,
    ]))
PY

echo "# Manifest"
echo "${MANIFEST}"
echo

echo "# Destination"
echo "${DEST_DIR}"
echo

echo "# Planned downloads"
awk -F '\t' '{ printf "%02d. %s\n", NR, $1 }' "${plan_file}"
echo

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "# DRY_RUN=true, not downloading."
  exit 0
fi

while IFS=$'\t' read -r file_name expected_sha256 download_url model_name model_id version_id model_url; do
  final_path="${DEST_DIR}/${file_name}"
  part_path="${final_path}.part"
  meta_path="${final_path}.civitai.json"
  sha_path="${final_path}.sha256"

  echo
  echo "# ${file_name}"
  echo "model: ${model_name}"
  echo "url: ${model_url}"

  if [[ -f "${final_path}" ]]; then
    actual_sha256="$(sha256sum "${final_path}" | awk '{print toupper($1)}')"
    if [[ "${actual_sha256}" == "${expected_sha256}" ]]; then
      echo "already exists and sha256 matches; skipping"
      continue
    fi

    echo "existing file has wrong sha256:" >&2
    echo "  expected: ${expected_sha256}" >&2
    echo "  actual:   ${actual_sha256}" >&2
    exit 1
  fi

  curl -fL \
    --retry 8 \
    --retry-delay 10 \
    --retry-all-errors \
    --continue-at - \
    "${headers[@]}" \
    -o "${part_path}" \
    "${download_url}"

  actual_sha256="$(sha256sum "${part_path}" | awk '{print toupper($1)}')"
  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "downloaded file sha256 mismatch:" >&2
    echo "  file:     ${part_path}" >&2
    echo "  expected: ${expected_sha256}" >&2
    echo "  actual:   ${actual_sha256}" >&2
    exit 1
  fi

  mv "${part_path}" "${final_path}"

  printf "%s  %s\n" "${expected_sha256}" "${file_name}" > "${sha_path}"

  python3 - "${meta_path}" "${file_name}" "${expected_sha256}" "${download_url}" "${model_name}" "${model_id}" "${version_id}" "${model_url}" <<'PY'
import json
import sys
from pathlib import Path

meta_path = Path(sys.argv[1])

data = {
    "file_name": sys.argv[2],
    "sha256": sys.argv[3],
    "download_url": sys.argv[4],
    "model_name": sys.argv[5],
    "model_id": sys.argv[6],
    "version_id": sys.argv[7],
    "model_url": sys.argv[8],
}

with meta_path.open("w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

  echo "downloaded and verified"
done < "${plan_file}"

echo
echo "# Complete"
find "${DEST_DIR}" -maxdepth 1 -type f -name '*.safetensors' -printf '%f\n' | sort