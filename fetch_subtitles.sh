#!/bin/bash
# Fetch all subtitles in parallel
DATA_DIR="/media/duxuan/software/duxuan/code/english/vidDict/data/subtitles"
mkdir -p "$DATA_DIR"

MAX_PARALLEL=5
COUNT=0
SUCCESS=0
FAIL=0

while IFS= read -r vid; do
  (
    curl -s -o "${DATA_DIR}/${vid}.json" "https://vidloop.cn/api/videos/${vid}/subtitles" -w "%{http_code}" > /tmp/hermes_sub_http_${vid} 2>/dev/null
  ) &
  
  COUNT=$((COUNT + 1))
  
  # Limit parallel jobs
  if [ $((COUNT % MAX_PARALLEL)) -eq 0 ]; then
    wait
  fi
  
  echo "Queued $COUNT/214"
done < /media/duxuan/software/duxuan/code/english/vidDict/data/video_ids.txt

wait
echo "All 214 subtitle requests completed"
