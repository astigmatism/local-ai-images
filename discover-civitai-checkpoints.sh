#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${OUT_DIR:-./tmp/civitai}"
RAW_FILE="${RAW_FILE:-${OUT_DIR}/checkpoint-candidates.raw.json}"
OUT_FILE="${OUT_FILE:-${OUT_DIR}/checkpoint-candidates.json}"

LIMIT="${LIMIT:-50}"
TYPES="${TYPES:-Checkpoint}"
SORT="${SORT:-Most Downloaded}"
PERIOD="${PERIOD:-AllTime}"
NSFW="${NSFW:-true}"
PRIMARY_FILE_ONLY="${PRIMARY_FILE_ONLY:-true}"

mkdir -p "${OUT_DIR}"

encode_query_value() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote_plus

print(quote_plus(sys.argv[1]))
PY
}

encoded_types="$(encode_query_value "${TYPES}")"
encoded_sort="$(encode_query_value "${SORT}")"
encoded_period="$(encode_query_value "${PERIOD}")"
encoded_nsfw="$(encode_query_value "${NSFW}")"
encoded_primary_file_only="$(encode_query_value "${PRIMARY_FILE_ONLY}")"

url="https://civitai.com/api/v1/models?limit=${LIMIT}&types=${encoded_types}&sort=${encoded_sort}&period=${encoded_period}&nsfw=${encoded_nsfw}&primaryFileOnly=${encoded_primary_file_only}"

headers=(
  -H "Accept: application/json"
  -A "local-ai-images-civitai-discovery/0.1"
)

if [[ -n "${CIVITAI_API_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${CIVITAI_API_TOKEN}")
fi

echo "# Query"
echo "${url}"
echo

curl -fL --retry 3 --retry-delay 5 "${headers[@]}" \
  -o "${RAW_FILE}" \
  "${url}"

python3 - "${RAW_FILE}" "${OUT_FILE}" "${TYPES}" "${SORT}" "${PERIOD}" "${NSFW}" <<'PY'
import json
import sys
from pathlib import Path

raw_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
types = sys.argv[3]
sort = sys.argv[4]
period = sys.argv[5]
nsfw = sys.argv[6]

with raw_path.open("r", encoding="utf-8") as f:
    data = json.load(f)

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

    hashes = primary.get("hashes") if isinstance(primary, dict) else {}
    stats = model.get("stats") or {}

    items.append({
        "model_id": model.get("id"),
        "model_name": model.get("name"),
        "model_type": model.get("type"),
        "nsfw": model.get("nsfw"),
        "nsfw_level": model.get("nsfwLevel"),
        "tags": model.get("tags") or [],
        "creator": (model.get("creator") or {}).get("username"),
        "stats": {
            "download_count": stats.get("downloadCount"),
            "thumbs_up_count": stats.get("thumbsUpCount"),
            "thumbs_down_count": stats.get("thumbsDownCount"),
            "rating": stats.get("rating"),
            "rating_count": stats.get("ratingCount"),
            "comment_count": stats.get("commentCount"),
        },
        "latest_version_id": latest.get("id"),
        "latest_version_name": latest.get("name"),
        "base_model": latest.get("baseModel"),
        "published_at": latest.get("publishedAt"),
        "trained_words": latest.get("trainedWords") or [],
        "file_id": primary.get("id") if primary else None,
        "file_name": primary.get("name") if primary else None,
        "file_size_kb": primary.get("sizeKB") if primary else None,
        "file_format": primary.get("format") if primary else None,
        "file_type": primary.get("type") if primary else None,
        "file_metadata": primary.get("metadata") if primary else None,
        "sha256": hashes.get("SHA256") if isinstance(hashes, dict) else None,
        "download_url": primary.get("downloadUrl") if primary else latest.get("downloadUrl"),
        "model_url": f"https://civitai.com/models/{model.get('id')}",
    })

result = {
    "source": "civitai",
    "query": {
        "types": types,
        "sort": sort,
        "period": period,
        "nsfw": nsfw,
    },
    "raw_file": str(raw_path),
    "count": len(items),
    "items": items,
}

with out_path.open("w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)

print(f"# Wrote {out_path}")
print(f"# Candidate count: {len(items)}")
PY

echo
echo "# Preview"
python3 - "${OUT_FILE}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])

with path.open("r", encoding="utf-8") as f:
    data = json.load(f)

for i, item in enumerate(data.get("items", [])[:25], start=1):
    stats = item.get("stats") or {}
    size_kb = item.get("file_size_kb")
    size_gib = size_kb / 1024 / 1024 if isinstance(size_kb, (int, float)) else None
    size_text = f"{size_gib:.2f} GiB" if size_gib is not None else "unknown size"

    print(f"{i:02d}. {item.get('model_name')} [{item.get('base_model')}]")
    print(f"    model_id={item.get('model_id')} version_id={item.get('latest_version_id')} file_id={item.get('file_id')}")
    print(f"    creator={item.get('creator')} downloads={stats.get('download_count')} rating={stats.get('rating')} nsfw={item.get('nsfw')} nsfw_level={item.get('nsfw_level')}")
    print(f"    file={item.get('file_name')} ({size_text})")
    print(f"    sha256={item.get('sha256')}")
    print(f"    url={item.get('model_url')}")
PY