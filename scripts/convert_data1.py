#!/usr/bin/env python3
"""
Convert data1/ videos from old format (snake_case subtitles, missing info fields)
to new format matching data/ (camelCase subtitles, full info.json fields).

This script:
1. Rewrites subtitles.json: start_time→startTime, end_time→endTime,
   english_text→textEn, chinese_text→textCn, keywords→highlightWords
2. Adds missing info.json fields: accent, author, category, tags,
   coverUrl, videoUrl, difficulty, source
3. Regenerates consolidated.json and meta.json
"""

import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA1_DIR = os.path.join(PROJECT_ROOT, "data1")
VIDEOS_DIR = os.path.join(DATA1_DIR, "videos")

LEVEL_TO_DIFFICULTY = {"初级": 1, "中级": 2, "高级": 3}
DIFFICULTY_TO_LEVEL = {1: "初级", 2: "中级", 3: "高级"}

# Accent mapping based on heuristics in title/description
ACCENT_RULES = [
    (["英国", "伦敦", "英式", "英音", "British"], "英音"),
    (["美国", "美式", "美音", "纽约", "迈阿密", "American", "USA"], "美音/加拿大"),
    (["加拿大", "澳大利亚", "澳洲", "爱尔兰", "丹麦", "瑞典", "挪威", "哥本哈根",
      "里斯本", "葡萄牙", "韩国", "越南", "伊斯坦布尔", "土耳其", "印尼",
      "India", "Indian", "南非", "非洲", "斯德哥尔摩", "奥斯陆", "科罗拉多"], "其他"),
]


def guess_accent(info):
    """Guess accent from title, description, topics, topic fields."""
    text = " ".join([
        info.get("title", ""),
        info.get("description", ""),
        info.get("topic", ""),
        " ".join(info.get("topics", [])),
    ])
    for keywords, accent in ACCENT_RULES:
        for kw in keywords:
            if kw in text:
                return accent
    return "其他"


def convert_subtitles(subtitles):
    """Convert snake_case subtitle fields to camelCase."""
    field_map = {
        "start_time": "startTime",
        "end_time": "endTime",
        "english_text": "textEn",
        "chinese_text": "textCn",
        "keywords": "highlightWords",
    }
    converted = []
    for sub in subtitles:
        new_sub = {}
        for old_key, value in sub.items():
            new_key = field_map.get(old_key, old_key)
            new_sub[new_key] = value
        # Ensure startTime/endTime are numbers not strings
        for time_key in ("startTime", "endTime"):
            if time_key in new_sub and isinstance(new_sub[time_key], str):
                try:
                    new_sub[time_key] = float(new_sub[time_key])
                except ValueError:
                    new_sub[time_key] = 0
        # Remove data1-specific fields that data/ format doesn't have
        new_sub.pop("index", None)
        new_sub.pop("sequence", None)
        converted.append(new_sub)
    return converted


def update_info(info):
    """Add missing fields to info.json for data/ compatibility."""
    updated = dict(info)

    # Map creator → author
    if "creator" in updated:
        updated["author"] = updated.pop("creator") or ""

    # Map topic → category
    if "topic" in updated:
        updated["category"] = updated.pop("topic") or ""

    # Map topics → tags
    if "topics" in updated:
        updated["tags"] = updated.pop("topics") or []

    # Add accent
    if "accent" not in updated or not updated["accent"]:
        updated["accent"] = guess_accent(info)

    # Add difficulty
    if "difficulty" not in updated:
        level = updated.get("level", "初级")
        updated["difficulty"] = LEVEL_TO_DIFFICULTY.get(level, 1)

    # Add missing fields with defaults
    updated.setdefault("coverUrl", "")
    updated.setdefault("videoUrl", "")
    updated.setdefault("source", "https://shadowtalk.top")

    # Remove data1-specific fields
    updated.pop("createdAt", None)

    return updated


def generate_consolidated():
    """Regenerate data1/consolidated.json in data/-compatible format."""
    videos = []
    all_levels = set()
    all_topics = set()
    all_accents = set()

    dirs = sorted(
        d for d in os.listdir(VIDEOS_DIR)
        if os.path.isdir(os.path.join(VIDEOS_DIR, d))
    )

    for dir_name in dirs:
        ep_dir = os.path.join(VIDEOS_DIR, dir_name)
        info_path = os.path.join(ep_dir, "info.json")
        if not os.path.exists(info_path):
            continue

        with open(info_path) as f:
            info = json.load(f)

        vid = info.get("id", dir_name)

        # Read subtitles
        subtitles = []
        subs_path = os.path.join(ep_dir, "subtitles.json")
        if os.path.exists(subs_path):
            with open(subs_path) as f:
                subtitles = json.load(f)

        # Collect levels, topics, accents
        level = info.get("level", "")
        if level:
            all_levels.add(level)

        accent = info.get("accent", "")
        if accent:
            all_accents.add(accent)

        tags = info.get("tags", info.get("topics", []))
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except (json.JSONDecodeError, TypeError):
                tags = [tags]
        if not tags and info.get("category"):
            tags = [info["category"]]
        for t in tags:
            if isinstance(t, str) and t.strip() and t not in ('"', "[", "]"):
                all_topics.add(t)

        topic = info.get("category", info.get("topic", (tags[0] if tags else "")))
        if isinstance(topic, list):
            topic = topic[0] if topic else ""

        # Video path
        video_path = os.path.join(ep_dir, "video.mp4")
        video_exists = os.path.exists(video_path) and os.path.getsize(video_path) > 1024
        video_rel = f"/data/videos/{dir_name}/video.mp4" if video_exists else None

        # Thumbnail path
        thumb_rel = None
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            cover_path = os.path.join(ep_dir, f"cover{ext}")
            if os.path.exists(cover_path):
                thumb_rel = f"/data/videos/{dir_name}/cover{ext}"
                break

        videos.append({
            "id": vid,
            "title": info.get("title", ""),
            "description": info.get("description", ""),
            "topic": topic,
            "topics": tags,
            "level": level,
            "accent": accent,
            "duration": info.get("duration", 0),
            "creator_name": info.get("author", info.get("creator", "")),
            "subtitle_count": len(subtitles),
            "subtitles": subtitles,
            "video_local": video_rel,
            "video_url": None,
            "thumbnail_local": thumb_rel,
            "episode_dir": dir_name,
        })

    # Write consolidated.json
    consolidated_path = os.path.join(DATA1_DIR, "consolidated.json")
    with open(consolidated_path, "w", encoding="utf-8") as f:
        json.dump(videos, f, ensure_ascii=False, indent=2)
    print(f"[consolidated] {len(videos)} videos written")

    # Write meta.json
    meta = {
        "levels": sorted(all_levels),
        "topics": sorted(all_topics),
        "accents": sorted(all_accents),
        "total_videos": len(videos),
    }
    meta_path = os.path.join(DATA1_DIR, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"[meta] levels={sorted(all_levels)}, topics={len(all_topics)}, "
          f"accents={sorted(all_accents)}")


def main():
    dirs = sorted(
        d for d in os.listdir(VIDEOS_DIR)
        if os.path.isdir(os.path.join(VIDEOS_DIR, d))
    )
    total = len(dirs)
    print(f"Found {total} video directories")

    for i, dir_name in enumerate(dirs, 1):
        ep_dir = os.path.join(VIDEOS_DIR, dir_name)

        # 1. Convert subtitles.json
        subs_path = os.path.join(ep_dir, "subtitles.json")
        if os.path.exists(subs_path):
            with open(subs_path) as f:
                subtitles = json.load(f)
            subtitles = convert_subtitles(subtitles)
            with open(subs_path, "w", encoding="utf-8") as f:
                json.dump(subtitles, f, ensure_ascii=False, indent=2)

        # 2. Update info.json
        info_path = os.path.join(ep_dir, "info.json")
        if os.path.exists(info_path):
            with open(info_path) as f:
                info = json.load(f)
            info = update_info(info)
            with open(info_path, "w", encoding="utf-8") as f:
                json.dump(info, f, ensure_ascii=False, indent=2)

        if i % 20 == 0:
            print(f"  [{i}/{total}] {dir_name}")

    print(f"[convert] All {total} videos converted")

    # 3. Regenerate consolidated.json and meta.json
    generate_consolidated()

    print("\nDone. data1/ is now compatible with data/ format.")


if __name__ == "__main__":
    main()
