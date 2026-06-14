#!/usr/bin/env python3
"""Download the 17 missing videos using proper URL handling."""
import json
import subprocess
import sys

DATA_DIR = "/media/duxuan/software/duxuan/code/english/vidDict/data"

missing = [
    "012e3d75-7b1a-4739-9c16-3afb0e9fd6eb", "0e4d4b9e-8a58-46d3-a9e8-a8c9d8b12c91",
    "22c2d995-1aa5-4785-9005-9b0110df456d", "25b32521-793e-465d-aeee-bc1ce73b77dc",
    "444ff1fb-5c8d-40cb-9fa5-33b34623642b", "47e7f35e-7871-4adc-8640-184f428d8311",
    "57ce9b60-6a74-4615-bc20-c608df46a6f5", "6365add3-d7f6-4209-98fa-5ab469a56bbf",
    "638662e0-4420-45ce-abd7-b24a1d02c1b0", "6d07d91c-1fb7-497d-a13b-1335c8124af4",
    "6d0a3c2d-3d83-405c-bb05-46ccee9bb7ee", "77f90f6f-c688-41fa-921e-d723c31d24c8",
    "c0fb0481-1263-45ff-b7f5-105382174e02", "c16da4a3-33fe-4a40-8bd5-401db08ae0e6",
    "caa8094a-e2d4-49b3-bad7-f80708e972b9", "e7685de4-8b2f-4071-a2ce-b5cf6ca0b108",
    "f587a78d-c0ae-4929-a0d2-1fa45a00f336"
]

with open(f"{DATA_DIR}/consolidated.json") as f:
    data = json.load(f)

vid_map = {v["id"]: v for v in data}

for i, vid in enumerate(missing):
    v = vid_map.get(vid)
    if not v:
        print(f"[{i+1}/17] SKIP {vid}: not in data")
        continue
    
    url = v["video_url"]
    outpath = f"{DATA_DIR}/videos/{vid}.mp4"
    title = v["title"][:40]
    
    print(f"[{i+1}/17] {vid} ({title})...")
    
    result = subprocess.run(
        ["curl", "-sL", "-o", outpath, url, "-w", "%{http_code}"],
        capture_output=True, text=True, timeout=300
    )
    code = result.stdout.strip()
    
    if code == "200":
        size_mb = subprocess.run(["du", "-sh", outpath], capture_output=True, text=True).stdout.split()[0]
        print(f"  OK {code} ({size_mb})")
    else:
        print(f"  FAIL HTTP {code}: {result.stderr[:100] if result.stderr else 'no error'}")

# Also download thumbnails
for i, vid in enumerate(missing):
    v = vid_map.get(vid)
    if not v or not v.get("thumbnail"):
        continue
    
    thumb_url = v["thumbnail"]
    ext = thumb_url.split("?")[0].split(".")[-1] or "jpg"
    outpath = f"{DATA_DIR}/thumbnails/{vid}.{ext}"
    
    result = subprocess.run(
        ["curl", "-sL", "-o", outpath, thumb_url, "-w", "%{http_code}"],
        capture_output=True, text=True, timeout=60
    )
    print(f"  Thumbnail: HTTP {result.stdout.strip()}")

print("\nDone!")
