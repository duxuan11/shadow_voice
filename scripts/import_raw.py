#!/usr/bin/env python3
"""
Import a video + bilingual SRT from the raw/ folder into the Shadow Voice data catalog.

Usage:
  python3 scripts/import_raw.py <video_name_without_ext> [level] [topic] [description] [topics_csv]

Example:
  python3 scripts/import_raw.py "Speak English With Me： Real Life Conversation" B1 日常对话 "English conversation practice" "日常对话,口语"

This creates/updates:
  - data/videos/<uuid>.mp4          (symlink to raw video)
  - data/thumbnails/<uuid>.jpg      (generated thumbnail)
  - data/consolidated.json          (appended/updated)
  - data/meta.json                  (regenerated)
  - data/shadow_voice.db            (SQLite DB, created if missing)
"""

import json, os, sys, uuid, re, subprocess, shutil
from datetime import timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(PROJECT_ROOT, 'raw')
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
CONSOLIDATED_PATH = os.path.join(DATA_DIR, 'consolidated.json')
META_PATH = os.path.join(DATA_DIR, 'meta.json')

def srt_time_to_seconds(t):
    """Convert SRT time format HH:MM:SS,mmm to seconds (float)."""
    parts = t.replace(',', '.').split(':')
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])

def ensure_dir(d):
    os.makedirs(d, exist_ok=True)

def parse_bilingual_srt(srt_path):
    """
    Parse a bilingual SRT where each entry has structure:
        <index>
        <start> --> <end>
        <english_text>
        <chinese_text>

    Returns list of {id, start_time, end_time, english_text, chinese_text}
    """
    entries = []
    with open(srt_path, 'r', encoding='utf-8') as f:
        lines = [l.rstrip('\n\r') for l in f.readlines()]

    i = 0
    entry_idx = 0
    while i < len(lines):
        line = lines[i].strip()
        # Match subtitle index number
        if re.match(r'^\d+$', line):
            i += 1
            if i >= len(lines):
                break
            # Parse timecode line
            time_match = re.match(r'(\S+)\s+-->\s+(\S+)', lines[i].strip())
            if not time_match:
                i += 1
                continue
            start_time = srt_time_to_seconds(time_match.group(1))
            end_time = srt_time_to_seconds(time_match.group(2))
            i += 1

            # Read English text (may span multiple lines)
            en_lines = []
            while i < len(lines):
                l = lines[i].strip()
                if not l:
                    break
                # Check if this line contains Chinese characters
                if re.search(r'[\u4e00-\u9fff\uff00-\uffef]', l):
                    # This is the Chinese line, English line(s) are done
                    break
                en_lines.append(l)
                i += 1

            english_text = ' '.join(en_lines).strip()

            # Read Chinese line
            chinese_text = ''
            if i < len(lines) and lines[i].strip():
                chinese_text = lines[i].strip()
                i += 1

            if english_text:
                entry_idx += 1
                entries.append({
                    'id': entry_idx,
                    'start_time': round(start_time, 3),
                    'end_time': round(end_time, 3),
                    'english_text': english_text,
                    'chinese_text': chinese_text,
                })
        i += 1

    return entries

def get_duration_seconds(video_path):
    """Get video duration using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)
    return float(data['format']['duration'])

def generate_thumbnail(video_path, output_path, time_sec=5):
    """Generate a thumbnail at the given time offset."""
    ensure_dir(os.path.dirname(output_path))
    cmd = [
        'ffmpeg', '-y', '-v', 'quiet',
        '-ss', str(time_sec),
        '-i', video_path,
        '-vframes', '1',
        '-q:v', '2',
        output_path
    ]
    subprocess.run(cmd, check=True, timeout=30)

def load_existing_consolidated():
    """Load existing consolidated.json, return list of video dicts."""
    if os.path.exists(CONSOLIDATED_PATH):
        with open(CONSOLIDATED_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_consolidated(videos):
    ensure_dir(DATA_DIR)
    with open(CONSOLIDATED_PATH, 'w', encoding='utf-8') as f:
        json.dump(videos, f, ensure_ascii=False, indent=2)

def generate_meta(videos):
    """Regenerate meta.json from the current video list."""
    all_levels = sorted(set(v.get('level', 'B1') for v in videos))
    all_topics = sorted(set(
        t for v in videos for t in v.get('topics', [])
    ))
    meta = {
        'levels': all_levels,
        'topics': all_topics,
        'total_videos': len(videos),
    }
    ensure_dir(DATA_DIR)
    with open(META_PATH, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/import_raw.py <video_name_without_ext>')
        print('Example: python3 scripts/import_raw.py "Speak English With Me： Real Life Conversation"')
        sys.exit(1)

    base_name = sys.argv[1]
    video_path = os.path.join(RAW_DIR, f'{base_name}.mp4')
    zh_en_srt = os.path.join(RAW_DIR, f'{base_name}.zh_en.srt')

    # Validate files exist
    if not os.path.exists(video_path):
        print(f'ERROR: Video not found: {video_path}')
        sys.exit(1)
    if not os.path.exists(zh_en_srt):
        print(f'ERROR: Bilingual SRT not found: {zh_en_srt}')
        sys.exit(1)

    print(f'[1/5] Parsing bilingual SRT...')
    subtitles = parse_bilingual_srt(zh_en_srt)
    print(f'       → {len(subtitles)} subtitle entries')

    print(f'[2/5] Getting video info...')
    duration = get_duration_seconds(video_path)
    print(f'       → Duration: {duration:.0f}s ({duration/60:.1f}min)')

    # Generate a UUID for the video
    video_id = str(uuid.uuid4())

    print(f'[3/5] Copying video and generating thumbnail...')
    ensure_dir(os.path.join(DATA_DIR, 'videos'))
    ensure_dir(os.path.join(DATA_DIR, 'thumbnails'))

    dst_video = os.path.join(DATA_DIR, 'videos', f'{video_id}.mp4')
    shutil.copy2(video_path, dst_video)
    print(f'       → Video copied to data/videos/{video_id}.mp4')

    thumbnail_path = os.path.join(DATA_DIR, 'thumbnails', f'{video_id}.jpg')
    generate_thumbnail(dst_video, thumbnail_path)
    print(f'       → Thumbnail generated')

    # Build video entry
    print(f'[4/5] Building video entry...')

    # Metadata from command-line args or defaults
    level = sys.argv[2] if len(sys.argv) > 2 else 'B1'
    topic = sys.argv[3] if len(sys.argv) > 3 else '日常对话'
    description = sys.argv[4] if len(sys.argv) > 4 else 'English conversation practice'
    topics_str = sys.argv[5] if len(sys.argv) > 5 else topic
    topics = [t.strip() for t in topics_str.split(',') if t.strip()]
    if topic not in topics:
        topics.insert(0, topic)

    video_entry = {
        'id': video_id,
        'title': base_name,
        'description': description,
        'level': level,
        'topic': topic,
        'topics': topics,
        'duration': round(duration),
        'subtitle_count': len(subtitles),
        'thumbnail': None,
        'thumbnail_local': f'/data/thumbnails/{video_id}.jpg',
        'video_url': None,
        'video_local': f'/data/videos/{video_id}.mp4',
        'subtitles': subtitles,
    }

    print(f'[5/5] Updating consolidated.json and meta.json...')
    videos = load_existing_consolidated()

    # Check if this video already exists (by title)
    existing = [v for v in videos if v['title'] == base_name]
    if existing:
        print(f'       → Updating existing entry for "{base_name}"')
        for v in videos:
            if v['title'] == base_name:
                v.update(video_entry)
    else:
        videos.append(video_entry)

    save_consolidated(videos)
    meta = generate_meta(videos)
    print(f'       → consolidated.json: {len(videos)} videos')
    print(f'       → meta.json: {len(meta["levels"])} levels, {len(meta["topics"])} topics')

    print()
    print('✅ Done! Video imported successfully.')
    print(f'   ID: {video_id}')
    print(f'   Title: {base_name}')
    print(f'   Duration: {duration:.0f}s')
    print(f'   Subtitles: {len(subtitles)}')
    print(f'   Level: {level}')
    print(f'   Topics: {topics}')
    print()
    print('Restart the Vite dev server to see the new video in the Library.')

if __name__ == '__main__':
    main()
