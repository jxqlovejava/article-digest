import subprocess, json, urllib.request, sys

# Check which HTML files have video/table content
result = subprocess.run(
    ["sudo", "docker", "exec", "tweet-archive", "sh", "-c",
     'grep -l "video\\|<table\\|mp4\\|youtube" /app/data/articles/*.html 2>/dev/null || echo none'],
    capture_output=True, text=True)
print("HTML files with video/table:", result.stdout.strip()[:500])

# Check tweets for media.videos via FxTwitter API
tweets = [
    ("kyriecheungyep", "2056917814183928042"),
    ("369Serena", "2061048455796330817"),
    ("AlchainHust", "2060923562345832451"),
    ("0xshimei", "2061066568126038448"),
]

for username, tid in tweets:
    url = "https://api.fxtwitter.com/{}/status/{}".format(username, tid)
    req = urllib.request.Request(url, headers={"User-Agent": "TweetArchive/1.0"})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        d = json.loads(resp.read())
        t = d.get("tweet", {})
        media = t.get("media", {}) or {}
        videos = media.get("videos", [])
        photos = media.get("photos", [])
        article = t.get("article")
        print("\n{}/{}:".format(username, tid))
        print("  text:", (t.get("text") or "")[:80])
        print("  media photos:", len(photos), "videos:", len(videos))
        for v in videos[:2]:
            print("    video:", v.get("url", "")[:120])
        if article:
            print("  article title:", (article.get("title") or "")[:80])
            me = article.get("media_entities") or []
            print("  article media_entities:", len(me))
            for m in me[:3]:
                mi = m.get("media_info") or {}
                print("    type:", mi.get("__typename"), "url:", (mi.get("original_img_url") or "")[:100])
    except Exception as e:
        print("  ERROR:", e)
