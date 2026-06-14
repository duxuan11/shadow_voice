#!/bin/bash
# Download only missing videos
DATA_DIR="/media/duxuan/software/duxuan/code/english/vidDict/data"
MISSING=(
  "012e3d75-7b1a-4739-9c16-3afb0e9fd6eb"
  "0e4d4b9e-8a58-46d3-a9e8-a8c9d8b12c91"
  "22c2d995-1aa5-4785-9005-9b0110df456d"
  "25b32521-793e-465d-aeee-bc1ce73b77dc"
  "444ff1fb-5c8d-40cb-9fa5-33b34623642b"
  "47e7f35e-7871-4adc-8640-184f428d8311"
  "57ce9b60-6a74-4615-bc20-c608df46a6f5"
  "6365add3-d7f6-4209-98fa-5ab469a56bbf"
  "638662e0-4420-45ce-abd7-b24a1d02c1b0"
  "6d07d91c-1fb7-497d-a13b-1335c8124af4"
  "6d0a3c2d-3d83-405c-bb05-46ccee9bb7ee"
  "77f90f6f-c688-41fa-921e-d723c31d24c8"
  "c0fb0481-1263-45ff-b7f5-105382174e02"
  "c16da4a3-33fe-4a40-8bd5-401db08ae0e6"
  "caa8094a-e2d4-49b3-bad7-f80708e972b9"
  "e7685de4-8b2f-4071-a2ce-b5cf6ca0b108"
  "f587a78d-c0ae-4929-a0d2-1fa45a00f336"
)

for vid in "${MISSING[@]}"; do
  # Get URL from consolidated.json using the video ID
  URL=$(python3 -c "
import json
with open('$DATA_DIR/consolidated.json') as f:
    data = json.load(f)
for v in data:
    if v['id'] == '$vid':
        print(v['video_url'])
        break
")
  if [ -n "$URL" ]; then
    echo "Downloading $vid ..."
    curl -L -o "${DATA_DIR}/videos/${vid}.mp4" "$URL" --progress-bar 2>&1
    echo "Done: $vid"
  else
    echo "SKIP $vid: no URL"
  fi
done
echo "=== ALL MISSING VIDEOS DONE ==="
