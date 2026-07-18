#!/usr/bin/env python3
"""
Re-archive short Twitter articles that may be quote tweets or retweets,
so they pick up the latest expandQuoteOrRetweet logic.

Run on the server (where the app is running on localhost:3000):
  python3 scripts/migrate-quote-tweets.py
"""
import json
import os
import time
from pathlib import Path
import urllib.request
import urllib.error

BASE = Path('/home/ubuntu/tweet-disgest/data')
META_FILE = BASE / 'meta.json'
ARCHIVE_API = 'http://localhost:3000/api/archive'
DELETE_API = 'http://localhost:3000/api/delete'


def api_post(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f'[error] {url} {e.code}: {body}')
        return {}
    except Exception as e:
        print(f'[error] {url} {e}')
        return {}


def main():
    with open(META_FILE) as f:
        meta = json.load(f)

    # Candidates: twitter source and short content key (likely quote/retweet/card)
    candidates = [
        m for m in meta
        if m.get('sourceType') == 'twitter' and len(m.get('contentKey', '')) < 100
    ]
    print(f'[migrate] candidates: {len(candidates)}')

    for m in candidates:
        file_name = m['fileName']
        tweet_url = m.get('tweetUrl')
        if not tweet_url:
            print(f'[skip] {file_name}: no tweetUrl')
            continue

        print(f'[migrate] {file_name} -> {tweet_url}')
        # Delete old article so /api/archive treats it as new
        api_post(DELETE_API, {'id': file_name})
        time.sleep(0.5)
        result = api_post(ARCHIVE_API, {'url': tweet_url})
        if result.get('success'):
            print(f'[ok] -> {result.get("fileName")}')
        else:
            print(f'[fail] {result.get("error", "unknown")}')
        time.sleep(1.5)  # be polite to FxTwitter API


if __name__ == '__main__':
    main()
