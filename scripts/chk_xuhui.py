import json, urllib.request

url = "https://api.fxtwitter.com/Xuhuicai888/status/2060340252380631403"
req = urllib.request.Request(url, headers={"User-Agent": "TweetArchive/1.0"})
resp = urllib.request.urlopen(req, timeout=10)
d = json.loads(resp.read())
t = d["tweet"]
art = t.get("article", {})

# Check media_entities
me = art.get("media_entities", [])
print("media_entities:", len(me))
for i, m in enumerate(me):
    mi = m.get("media_info", {})
    typename = mi.get("__typename", "unknown")
    print("  [{}] type={} keys={}".format(i, typename, list(mi.keys())))
    if typename == "ApiVideo":
        vi = mi.get("video_info", {})
        vars_list = vi.get("variants", [])
        for v in vars_list[:3]:
            ct = v.get("content_type", "?")
            br = v.get("bitrate", 0)
            u = v.get("url", "")[:100]
            print("       variant: {} bitrate={} url={}".format(ct, br, u))

# Check entityMap
em = art.get("content", {}).get("entityMap", [])
types = {}
for entry in em:
    v = entry.get("value", {})
    t2 = v.get("type", "unknown")
    types[t2] = types.get(t2, 0) + 1
print("entityMap types:", types)

# Check blocks
blocks = art.get("content", {}).get("blocks", [])
btypes = {}
for b in blocks:
    bt = b.get("type", "unknown")
    btypes[bt] = btypes.get(bt, 0) + 1
print("block types:", btypes)

# Find table entities
for entry in em:
    v = entry.get("value", {})
    if v.get("type") == "MARKDOWN":
        md = v.get("data", {}).get("markdown", "")
        if "|" in md and ("---" in md or ":-" in md):
            print("TABLE entity key={}:".format(entry.get("key")))
            print(md[:500])
            print("---")
