#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${OUT_DIR:-./tmp/civitai}"
OUT_FILE="${OUT_FILE:-${OUT_DIR}/checkpoint-candidates.json}"
LIMIT="${LIMIT:-50}"
SORT="${SORT:-Most Downloaded}"
PERIOD="${PERIOD:-AllTime}"
TYPES="${TYPES:-Checkpoint}"

mkdir -p "${OUT_DIR}"

encoded_sort="$(python3 - <<'PY' "${SORT}"
import sys
from urllib.parse import quote
print(quote(sys.argv[1]))
PY
)"

url="https://civitai.com/api/v1/models?limit=${LIMIT}&types=${TYPES}&sort=${encoded_sort}&period=${PERIOD}"

headers=(-H "Accept: application/json")
if [[ -n "${CIVITAI_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${CIVITAI_API_TOKEN}")
fi

echo "# Query"
echo "${url}"
echo

curl -fsSL "${headers[@]}" "${url}" \
  | python3 - <<'PY' > "${OUT_FILE}"
import json
import sys

data = json.load(sys.stdin)

items = []
for model in data.get("items", []):
    versions = model.get("modelVersions") or []
    latest = versions[0] if versions else {}
    files = latest.get("files") or []

    primary = None
    for file in files:
        if file.get("primary") is True:
            primary = file
            break
    if primary is None and files:
        primary = files[0]

    items.append({
        "model_id": model.get("id"),
        "model_name": model.get("name"),
        "model_type": model.get("type"),
        "nsfw": model.get("nsfw"),
        "nsfw_level": model.get("nsfwLevel"),
        "tags": model.get("tags") or [],
        "creator": (model.get("creator") or {}).get("username"),
        "stats": model.get("stats") or {},
        "latest_version_id": latest.get("id"),
        "latest_version_name": latest.get("name"),
        "base_model": latest.get("baseModel"),
        "published_at": latest.get("publishedAt"),
        "file_name": primary.get("name") if primary else None,
        "file_id": primary.get("id") if primary else None,
        "file_size_kb": primary.get("sizeKB") if primary else None,
        "file_format": primary.get("format") if primary else None,
        "file_type": primary.get("type") if primary else None,
        "file_metadata": primary.get("metadata") if primary else None,
        "sha256": ((primary.get("hashes") or {}).get("SHA256") if primary else None),
        "download_url": primary.get("downloadUrl") if primary else latest.get("downloadUrl"),
        "model_url": f"https://civitai.com/models/{model.get('id')}",
    })

print(json.dumps({
    "source": "civitai",
    "query": {
        "types": "Checkpoint",
        "sort": "Most Downloaded",
        "period": "AllTime",
    },
    "count": len(items),
    "items": items,
}, indent=2))
PY

echo "# Wrote"
echo "${OUT_FILE}"
echo

echo "# Preview"
python3 - <<'PY' "${OUT_FILE}"
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

for i, item in enumerate(data["items"][:20], start=1):
    stats = item.get("stats") or {}
    size_kb = item.get("file_size_kb")
    size_gb = size_kb / 1024 / 1024 if isinstance(size_kb, (int, float)) else None
    size_text = f"{size_gb:.2f} GiB" if size_gb is not None else "unknown size"

    print(f"{i:02d}. {item.get('model_name')} [{item.get('base_model')}]")
    print(f"    model_id={item.get('model_id')} version_id={item.get('latest_version_id')} file_id={item.get('file_id')}")
    print(f"    creator={item.get('creator')} downloads={stats.get('downloadCount')} rating={stats.get('rating')} nsfw={item.get('nsfw')} nsfw_level={item.get('nsfw_level')}")
    print(f"    file={item.get('file_name')} ({size_text})")
    print(f"    url={item.get('model_url')}")
PY