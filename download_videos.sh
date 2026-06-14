#!/bin/bash
# Download all videos in background (estimated ~19.5GB)
DATA_DIR="/media/duxuan/software/duxuan/code/english/vidDict/data/videos"
mkdir -p "$DATA_DIR"

cat /media/duxuan/software/duxuan/code/english/vidDict/data/videos.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for v in data:
    # Extract filename from URL or use title
    url = v['video_url']
    vid = v['id']
    ext = url.split('?')[0].split('.')[-1] if '.' in url.split('?')[0] else 'mp4'
    filename = f'{vid}.{ext}'
    print(f'{url}|{filename}')
" | while IFS='|' read -r url filename; do
  echo "Downloading $filename ..."
  curl -L -o "${DATA_DIR}/${filename}" "$url" --progress-bar 2>&1
  echo "Done: $filename"
done
echo "=== ALL VIDEOS DOWNLOADED ==="
