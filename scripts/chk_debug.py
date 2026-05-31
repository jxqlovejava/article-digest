import json, urllib.request

url = "https://api.fxtwitter.com/Xuhuicai888/status/2060340252380631403"
req = urllib.request.Request(url, headers={"User-Agent": "TweetArchive/1.0"})
resp = urllib.request.urlopen(req, timeout=10)
d = json.loads(resp.read())
t = d["tweet"]
art = t.get("article", {})

em = art.get("content", {}).get("entityMap", [])

# Build key map
key_map = {}
for i, entry in enumerate(em):
    k = entry.get("key", "?")
    v = entry.get("value", {})
    key_map[int(k)] = {"idx": i, "type": v.get("type"), "data": v.get("data", {})}
    print("em key={} idx={} type={}".format(k, i, v.get("type")))

# Show block entity references
blocks = art.get("content", {}).get("blocks", [])
for i, b in enumerate(blocks):
    if b.get("type") == "atomic":
        for r in b.get("entityRanges", []):
            rk = r.get("key")
            info = key_map.get(rk, {})
            print("Block[{}] atomic -> entityKey={} type={} data={}".format(
                i, rk, info.get("type", "?"), str(info.get("data", {}))[:200]))
