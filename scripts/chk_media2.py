import json, urllib.request

url = "https://api.fxtwitter.com/Xuhuicai888/status/2060340252380631403"
req = urllib.request.Request(url, headers={"User-Agent": "TweetArchive/1.0"})
resp = urllib.request.urlopen(req, timeout=10)
d = json.loads(resp.read())
t = d["tweet"]
art = t.get("article", {})

# Check MEDIA entities
em = art.get("content", {}).get("entityMap", [])
for entry in em:
    v = entry.get("value", {})
    if v.get("type") == "MEDIA":
        print("MEDIA entity key={}:".format(entry.get("key")))
        print(json.dumps(v, ensure_ascii=False, indent=2)[:600])
        print("---")

# Check blocks that reference MEDIA entities
blocks = art.get("content", {}).get("blocks", [])
for i, b in enumerate(blocks):
    if b.get("type") == "atomic":
        er = b.get("entityRanges", [])
        for r in er:
            ent = em[r.get("key", -1)] if r.get("key", -1) < len(em) else None
            if ent:
                v = ent.get("value", {})
                print("Block [{}] atomic -> entity[{}] type={}".format(i, r.get("key"), v.get("type", "?")))
