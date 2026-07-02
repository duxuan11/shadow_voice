#!/usr/bin/env python3
"""Download all videos, subtitles, and metadata from shadowtalk.top into data1/"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_URL = "https://shadowtalk.top"
API_VIDEOS = f"{BASE_URL}/api/videos"
API_SUBTITLES = BASE_URL + "/api/videos/{}/subtitles"  # videoId
DATA_DIR = Path(__file__).parent / "data1"

def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except Exception as e:
            if attempt < retries - 1:
                print(f"  Retry {attempt+1}/{retries} for {url}: {e}")
                time.sleep(2)
            else:
                raise

def sanitize_filename(name):
    """Keep Chinese chars, alphanumeric, and safe chars; replace others with _"""
    name = name.strip()
    name = re.sub(r'[\\/*?:"<>|]', '_', name)
    return name

def format_srt_time(seconds):
    """Format seconds to SRT timestamp HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def subtitles_to_srt(subtitles):
    """Convert subtitles list to SRT format"""
    lines = []
    for i, sub in enumerate(subtitles, 1):
        start = sub.get('startTime', 0)
        end = sub.get('endTime', 0)
        text_en = sub.get('textEn', '')
        text_cn = sub.get('textCn', '')
        lines.append(str(i))
        lines.append(f"{format_srt_time(start)} --> {format_srt_time(end)}")
        lines.append(f"{text_en}\n{text_cn}")
        lines.append("")
    return "\n".join(lines)

def download_file(url, dest_path):
    """Download a file using curl with resume support"""
    dest_path = Path(dest_path)
    # Remove previously failed downloads (403 HTML pages)
    if dest_path.exists() and dest_path.stat().st_size < 1024:
        dest_path.unlink()
        print(f"    Removing stale download: {dest_path.name}")

    if dest_path.exists():
        print(f"    File already exists: {dest_path.name}")
        return

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(dest_path.suffix + '.tmp')

    # URL-encode the path portion to handle Chinese characters
    from urllib.parse import urlparse, quote, urlunparse
    parsed = urlparse(url)
    encoded_path = quote(parsed.path, safe='/:@!$&\'()*+,;=')
    encoded_url = urlunparse(parsed._replace(path=encoded_path))

    cmd = [
        'curl', '-L', '--retry', '3', '--retry-delay', '5',
        '-C', '-',  # resume
        '--connect-timeout', '15',
        '--max-time', '600',
        '-H', 'Referer: https://shadowtalk.top/',
        '-o', str(tmp_path),
        encoded_url
    ]

    print(f"    Downloading: {dest_path.name} ...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        tmp_path.rename(dest_path)
        size_mb = dest_path.stat().st_size / (1024 * 1024)
        print(f"    Done: {dest_path.name} ({size_mb:.1f} MB)")
    else:
        print(f"    ERROR downloading {url}: {result.stderr[-200:]}")
        if tmp_path.exists():
            tmp_path.unlink()
        raise RuntimeError(f"Download failed: {url}")

def fetch_all_videos():
    """Fetch all videos across all paginated pages"""
    all_videos = []

    # Fetch first page to get pagination info
    print("Fetching page 1...")
    resp = fetch_json(f"{API_VIDEOS}?page=1&limit=50")
    data = resp['data']
    all_videos.extend(data['videos'])
    pagination = data['pagination']
    total = pagination['total']
    total_pages = pagination['totalPages']
    print(f"  Total: {total} videos across {total_pages} pages")

    # Fetch remaining pages
    for page in range(2, total_pages + 1):
        print(f"Fetching page {page}...")
        resp = fetch_json(f"{API_VIDEOS}?page={page}&limit=50")
        all_videos.extend(resp['data']['videos'])

    return all_videos

def main():
    print("=" * 60)
    print("Shadow Talk Video Downloader")
    print("=" * 60)

    # Fetch all videos across all pages
    print("\nFetching video list...")
    videos = fetch_all_videos()
    print(f"Found {len(videos)} videos\n")

    total = len(videos)
    success_count = 0
    skip_count = 0
    fail_count = 0

    for idx, video in enumerate(videos, 1):
        vid = video['id']
        ep = video.get('episodeNumber', idx)
        title = video['title']
        desc = video.get('description', '')
        video_url = video.get('videoUrl', '')
        cover_url = video.get('coverUrl', '')
        author = video.get('author', '')
        duration = video.get('duration', 0)
        difficulty = video.get('difficulty', 0)
        category = (video.get('category') or {}).get('name', '')
        tags = [t['name'] for t in (video.get('tags') or [])]

        folder_name = f"{ep:02d}_{sanitize_filename(title)}"
        video_dir = DATA_DIR / "videos" / folder_name

        print(f"[{idx}/{total}] {folder_name}")

        # Check if already complete (valid video + info exist)
        video_path = video_dir / "video.mp4"
        info_path = video_dir / "info.json"

        # Remove stale downloads
        if video_path.exists() and video_path.stat().st_size < 1024:
            video_path.unlink()
        cover_path = None  # will be set later

        if video_path.exists() and info_path.exists():
            print(f"  Already complete, skipping")
            skip_count += 1
            continue

        try:
            video_dir.mkdir(parents=True, exist_ok=True)

            # 1. Save video info/metadata
            info = {
                "id": vid,
                "title": title,
                "description": desc,
                "episodeNumber": ep,
                "author": author,
                "coverUrl": cover_url,
                "videoUrl": video_url,
                "duration": duration,
                "difficulty": difficulty,
                "category": category,
                "tags": tags,
                "source": BASE_URL,
            }
            with open(info_path, 'w', encoding='utf-8') as f:
                json.dump(info, f, ensure_ascii=False, indent=2)
            print(f"  Info saved")

            # 2. Fetch and save subtitles
            sub_url = API_SUBTITLES.format(vid)
            try:
                sub_resp = fetch_json(sub_url)
                subtitles = sub_resp.get('data', {}).get('subtitles', [])

                # Save raw JSON
                sub_json_path = video_dir / "subtitles.json"
                with open(sub_json_path, 'w', encoding='utf-8') as f:
                    json.dump(subtitles, f, ensure_ascii=False, indent=2)

                # Save SRT format (bilingual)
                srt_path = video_dir / "subtitles.srt"
                srt_content = subtitles_to_srt(subtitles)
                with open(srt_path, 'w', encoding='utf-8') as f:
                    f.write(srt_content)

                print(f"  Subtitles saved ({len(subtitles)} entries)")
            except Exception as e:
                print(f"  WARNING: Could not fetch subtitles: {e}")

            # 3. Download video
            if video_url:
                download_file(video_url, video_path)
            else:
                print(f"  No video URL")

            # 4. Download cover image
            if cover_url:
                cover_ext = os.path.splitext(cover_url.split('?')[0])[1] or '.png'
                cover_path = video_dir / f"cover{cover_ext}"
                try:
                    download_file(cover_url, cover_path)
                except Exception as e:
                    print(f"  WARNING: Cover download failed: {e}")

            success_count += 1

        except Exception as e:
            print(f"  FAILED: {e}")
            fail_count += 1

    print("\n" + "=" * 60)
    print(f"COMPLETE: {success_count} success, {skip_count} skipped, {fail_count} failed")
    print(f"Data saved to: {DATA_DIR}")
    print("=" * 60)

if __name__ == "__main__":
    main()
