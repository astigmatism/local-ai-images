#!/usr/bin/env bash
set -euo pipefail

MANIFEST="${MANIFEST:-./civitai-checkpoint-selection.json}"
DEST_DIR="${DEST_DIR:-}"
DRY_RUN="${DRY_RUN:-false}"
ON_ACCESS_DENIED="${ON_ACCESS_DENIED:-skip}"
DOWNLOAD_DELAY_SECONDS="${DOWNLOAD_DELAY_SECONDS:-5}"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "Manifest not found: ${MANIFEST}" >&2
  exit 1
fi

if [[ "${ON_ACCESS_DENIED}" != "skip" && "${ON_ACCESS_DENIED}" != "fail" ]]; then
  echo "ON_ACCESS_DENIED must be either 'skip' or 'fail'." >&2
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
  -A "local-ai-images-civitai-downloader/0.2"
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

failure_log="${DEST_DIR}/civitai-download-failures.tsv"
status_log="${DEST_DIR}/civitai-download-status.tsv"

printf "timestamp\tstatus\thttp_code\tfile_name\tmodel_name\tmodel_id\tversion_id\tmodel_url\n" > "${failure_log}"
printf "timestamp\tstatus\thttp_code\tfile_name\tmodel_name\tmodel_id\tversion_id\tmodel_url\n" > "${status_log}"

log_status() {
  local status="$1"
  local http_code="$2"
  local file_name="$3"
  local model_name="$4"
  local model_id="$5"
  local version_id="$6"
  local model_url="$7"

  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "${timestamp}" \
    "${status}" \
    "${http_code}" \
    "${file_name}" \
    "${model_name}" \
    "${model_id}" \
    "${version_id}" \
    "${model_url}" >> "${status_log}"

  case "${status}" in
    access_denied|download_failed|sha256_mismatch)
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "${timestamp}" \
        "${status}" \
        "${http_code}" \
        "${file_name}" \
        "${model_name}" \
        "${model_id}" \
        "${version_id}" \
        "${model_url}" >> "${failure_log}"
      ;;
  esac
}

echo "# Manifest"
echo "${MANIFEST}"
echo

echo "# Destination"
echo "${DEST_DIR}"
echo

echo "# Access-denied behavior"
echo "ON_ACCESS_DENIED=${ON_ACCESS_DENIED}"
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
      log_status "already_verified" "" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"
      continue
    fi

    echo "existing file has wrong sha256:" >&2
    echo "  expected: ${expected_sha256}" >&2
    echo "  actual:   ${actual_sha256}" >&2
    log_status "sha256_mismatch" "" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"
    exit 1
  fi

  if [[ -f "${part_path}" ]]; then
    part_sha256="$(sha256sum "${part_path}" | awk '{print toupper($1)}')"
    if [[ "${part_sha256}" == "${expected_sha256}" ]]; then
      echo "partial file is already complete and sha256 matches; finalizing"
      mv "${part_path}" "${final_path}"
      printf "%s  %s\n" "${expected_sha256}" "${file_name}" > "${sha_path}"
      log_status "finalized_existing_part" "" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"
      continue
    fi
  fi

  set +e
  http_code="$(
    curl -fL \
      --retry 5 \
      --retry-delay 10 \
      --retry-connrefused \
      --continue-at - \
      --write-out "%{http_code}" \
      "${headers[@]}" \
      -o "${part_path}" \
      "${download_url}"
  )"
  curl_exit="$?"
  set -e

  if [[ "${curl_exit}" -ne 0 ]]; then
    case "${http_code}" in
      401|403)
        echo "access denied with HTTP ${http_code}: ${file_name}" >&2
        echo "This usually requires a Civitai API token or account access for this model." >&2
        log_status "access_denied" "${http_code}" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"

        if [[ "${ON_ACCESS_DENIED}" == "fail" ]]; then
          exit 1
        fi

        echo "skipping because ON_ACCESS_DENIED=skip"
        sleep "${DOWNLOAD_DELAY_SECONDS}"
        continue
        ;;
      *)
        echo "download failed for ${file_name}" >&2
        echo "curl exit: ${curl_exit}" >&2
        echo "http code: ${http_code}" >&2
        log_status "download_failed" "${http_code}" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"
        exit 1
        ;;
    esac
  fi

  actual_sha256="$(sha256sum "${part_path}" | awk '{print toupper($1)}')"
  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "downloaded file sha256 mismatch:" >&2
    echo "  file:     ${part_path}" >&2
    echo "  expected: ${expected_sha256}" >&2
    echo "  actual:   ${actual_sha256}" >&2
    log_status "sha256_mismatch" "${http_code}" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"
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
  log_status "downloaded_verified" "${http_code}" "${file_name}" "${model_name}" "${model_id}" "${version_id}" "${model_url}"

  sleep "${DOWNLOAD_DELAY_SECONDS}"
done < "${plan_file}"

echo
echo "# Complete"
find "${DEST_DIR}" -maxdepth 1 -type f -name '*.safetensors' -printf '%f\n' | sort

echo
echo "# Status log"
echo "${status_log}"

echo
echo "# Failure log"
echo "${failure_log}"