#!/usr/bin/env python3
"""Add level and accent fields to all info.json files in data/videos/"""

import json
import os
import sys

VIDEOS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'videos')

def derive_level(difficulty, existing_level=''):
    if existing_level and existing_level in ('初级', '中级', '高级'):
        return existing_level
    if difficulty is None:
        return ''
    d = int(difficulty)
    if d <= 2:
        return '初级'
    elif d == 3:
        return '中级'
    else:
        return '高级'

def derive_accent(tags):
    if not tags:
        return '其他'
    tag_str = ' '.join(tags).lower()
    if '英国' in tag_str or '英式' in tag_str or '英国伯明翰' in tag_str:
        return '英音'
    if '美国' in tag_str or '加拿大' in tag_str or '美式' in tag_str:
        return '美音/加拿大'
    return '其他'

def main():
    if not os.path.isdir(VIDEOS_DIR):
        print(f'Error: {VIDEOS_DIR} not found')
        sys.exit(1)

    updated = 0
    stats = {'初级': 0, '中级': 0, '高级': 0, '': 0,
             '英音': 0, '美音/加拿大': 0, '其他': 0}

    for dirname in sorted(os.listdir(VIDEOS_DIR)):
        epdir = os.path.join(VIDEOS_DIR, dirname)
        if not os.path.isdir(epdir):
            continue
        infopath = os.path.join(epdir, 'info.json')
        if not os.path.isfile(infopath):
            continue

        with open(infopath, 'r', encoding='utf-8') as f:
            info = json.load(f)

        old_level = info.get('level', '')
        old_accent = info.get('accent', '')

        new_level = derive_level(info.get('difficulty'), old_level)
        new_accent = derive_accent(info.get('tags', []))

        changed = False
        if not old_level and new_level:
            info['level'] = new_level
            changed = True
        if not old_accent:
            info['accent'] = new_accent
            changed = True

        if changed:
            with open(infopath, 'w', encoding='utf-8') as f:
                json.dump(info, f, ensure_ascii=False, indent=2)
            updated += 1

        stats[info.get('level', '')] = stats.get(info.get('level', ''), 0) + 1
        stats[info.get('accent', '')] = stats.get(info.get('accent', ''), 0) + 1

    print(f'Updated {updated} info.json files')
    print(f'Levels: { {k:v for k,v in stats.items() if k in ("初级","中级","高级","")} }')
    print(f'Accents: { {k:v for k,v in stats.items() if k in ("英音","美音/加拿大","其他")} }')

if __name__ == '__main__':
    main()
