#!/bin/bash
# Download all thumbnails
DATA_DIR="/media/duxuan/software/duxuan/code/english/vidDict/data/thumbnails"
mkdir -p "$DATA_DIR"

cat /media/duxuan/software/duxuan/code/english/vidDict/data/videos.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for v in data:
    url = v['thumbnail']
    vid = v['id']
    ext = url.split('?')[0].split('.')[-1] if '.' in url.split('?')[0] else 'jpg'
    filename = f'{vid}.{ext}'
    print(f'{url}|{filename}')
" | while IFS='|' read -r url filename; do
  echo "Downloading thumbnail $filename ..."
  curl -s -o "${DATA_DIR}/${filename}" "$url"
  echo "Done: $filename"
done
echo "=== ALL THUMBNAILS DOWNLOADED ==="
