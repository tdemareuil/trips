#!/usr/bin/env python3
"""Resolve photos, coordinates and driving routes for every trip in data/trips/.

Writes data/images.json (Wikipedia lead images, credits and coordinates) and
data/routes.json (road geometry per driving day, from the public OSRM server).
Entries already present are kept; pass --refresh to fetch everything again.

    python3 scripts/build_data.py
    python3 scripts/build_data.py --refresh
"""
import argparse
import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WIKI_API = "https://en.wikipedia.org/w/api.php"
FR_WIKI_API = "https://fr.wikipedia.org/w/api.php"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson"
USER_AGENT = "trips-site-build/1.0 (https://github.com/tdemareuil/trips)"
BATCH = 40
THUMB_WIDTH = 1920


def get_json(url, params=None):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def load_trips():
    return [json.loads(p.read_text()) for p in sorted((DATA / "trips").glob("*.json"))]


def load_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def chunks(items, size):
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


# --- Images ----------------------------------------------------------------

def collect_keys(trips):
    """Every Wikipedia article title or 'File:' title referenced by the trips."""
    keys = set()
    for trip in trips:
        keys.add(trip.get("cover"))
        for day in trip["days"]:
            keys.add(day.get("hero"))
            stay = day.get("stay")
            if stay:
                keys.add(stay.get("wiki"))
            for stop in day["stops"]:
                keys.add(stop.get("wiki"))
                keys.add(stop.get("photo"))
    return {k for k in keys if k}


def resolve_pages(query, titles):
    """Map each requested title to its page, following normalisation and redirects."""
    alias = {i["from"]: i["to"] for i in query.get("normalized", []) + query.get("redirects", [])}
    pages = {p["title"]: p for p in query["pages"].values()}
    out = {}
    for title in titles:
        resolved = title
        for _ in range(3):
            resolved = alias.get(resolved, resolved)
        out[title] = pages.get(resolved, {})
    return out


def fetch_articles(titles):
    """Return {title: {"file": "File:...", "lat": .., "lon": .., "fr": "Titre"}} for article titles."""
    out = {}
    for chunk in chunks(titles, BATCH):
        query = get_json(WIKI_API, {
            "action": "query", "format": "json", "redirects": 1,
            "prop": "pageimages|coordinates|langlinks", "piprop": "name",
            "lllang": "fr", "pilimit": "max", "colimit": "max", "lllimit": "max",
            "titles": "|".join(chunk),
        })["query"]
        for title, page in resolve_pages(query, chunk).items():
            entry = {}
            if page.get("pageimage"):
                entry["file"] = "File:" + page["pageimage"].replace("_", " ")
            if page.get("coordinates"):
                entry["lat"] = round(page["coordinates"][0]["lat"], 5)
                entry["lon"] = round(page["coordinates"][0]["lon"], 5)
            if page.get("langlinks"):
                entry["fr"] = page["langlinks"][0]["*"]
            out[title] = entry
    return out


def clean_extract(text, limit=260):
    """Keep the first sentences of an intro, without parentheses, up to about `limit` characters."""
    text = re.sub(r"\s*\[[^\]]*\]", "", text)
    while True:  # innermost parentheses first, so nested ones go too
        shorter = re.sub(r"\s*\([^()]*\)", "", text)
        if shorter == text:
            break
        text = shorter
    text = re.sub(r"\s+", " ", text).strip()
    out = ""
    for sentence in re.split(r"(?<=[.!?])\s+(?=[A-ZÀ-Ý])", text):
        if out and len(out) + len(sentence) + 1 > limit:
            break
        out = f"{out} {sentence}".strip()
    if len(out) > limit + 120:
        out = out[:limit + 120].rsplit(" ", 1)[0] + "…"
    return out


def fetch_extracts(titles):
    """Return {French title: {"extract": .., "article": url}} from French Wikipedia."""
    out = {}
    for chunk in chunks(titles, 20):
        query = get_json(FR_WIKI_API, {
            "action": "query", "format": "json", "redirects": 1,
            "prop": "extracts|info", "exintro": 1, "explaintext": 1, "exlimit": "max",
            "inprop": "url", "titles": "|".join(chunk),
        })["query"]
        for title, page in resolve_pages(query, chunk).items():
            if page.get("extract"):
                out[title] = {"extract": clean_extract(page["extract"]), "article": page["fullurl"]}
    return out


def fetch_files(file_titles):
    """Return {"File:...": {"url", "page", "artist", "license"}} for Commons files."""
    out = {}
    for chunk in chunks(file_titles, BATCH):
        query = get_json(WIKI_API, {
            "action": "query", "format": "json", "prop": "imageinfo",
            "iiprop": "url|extmetadata", "iiurlwidth": THUMB_WIDTH,
            "titles": "|".join(chunk),
        })["query"]
        for page in query["pages"].values():
            info = (page.get("imageinfo") or [None])[0]
            if not info:
                continue
            meta = info.get("extmetadata", {})
            artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", ""))
            out[page["title"]] = {
                "url": (info.get("thumburl") or info["url"]).split("?")[0],
                "page": info["descriptionurl"],
                "artist": html.unescape(artist).strip(),
                "license": meta.get("LicenseShortName", {}).get("value", ""),
            }
    return out


def build_images(trips, refresh):
    path = DATA / "images.json"
    images = {} if refresh else load_json(path)
    missing = sorted(k for k in collect_keys(trips) if k not in images)
    if not missing:
        print("images: up to date")
        return images

    files = {k.replace("_", " ") for k in missing if k.startswith("File:")}
    articles = fetch_articles([k for k in missing if not k.startswith("File:")])
    files |= {a["file"] for a in articles.values() if a.get("file")}
    infos = fetch_files(sorted(files))
    extracts = fetch_extracts(sorted({a["fr"] for a in articles.values() if a.get("fr")}))

    for key in missing:
        if key.startswith("File:"):
            images[key] = infos.get(key.replace("_", " "), {})
        else:
            art = articles[key]
            images[key] = {**infos.get(art.get("file"), {}),
                           **{k: art[k] for k in ("lat", "lon") if k in art},
                           **extracts.get(art.get("fr"), {})}
            if "extract" not in images[key]:
                print(f"images: no French extract for {key!r}")
        if not images[key].get("url"):
            print(f"images: no photo for {key!r}")
    path.write_text(json.dumps(images, indent=1, ensure_ascii=False) + "\n")
    print(f"images: {len(missing)} fetched")
    return images


# --- Routes ----------------------------------------------------------------

def position(item, images):
    """(lon, lat) of a stop or stay, from its own coords or its Wikipedia article."""
    if item.get("coords"):
        return (item["coords"][1], item["coords"][0])
    img = images.get(item.get("wiki"), {})
    if "lat" in img:
        return (img["lon"], img["lat"])
    return None


def day_waypoints(days, i, images):
    points = []
    if i > 0 and days[i - 1].get("stay"):
        points.append(position(days[i - 1]["stay"], images))
    points += [position(s, images) for s in days[i]["stops"]]
    if days[i].get("stay"):
        points.append(position(days[i]["stay"], images))
    points = [p for p in points if p]
    return [p for j, p in enumerate(points) if j == 0 or p != points[j - 1]]


def thin(coords, tol=0.0008):
    kept = [coords[0]]
    for lon, lat in coords[1:-1]:
        if max(abs(lon - kept[-1][0]), abs(lat - kept[-1][1])) > tol:
            kept.append([lon, lat])
    kept.append(coords[-1])
    return [[round(lon, 5), round(lat, 5)] for lon, lat in kept]


def build_routes(trips, images, refresh):
    path = DATA / "routes.json"
    routes = {} if refresh else load_json(path)
    fetched = 0
    for trip in trips:
        store = routes.setdefault(trip["id"], {})
        for i, day in enumerate(trip["days"]):
            if day.get("route") != "drive":
                continue
            via = [[round(lon, 5), round(lat, 5)] for lon, lat in day_waypoints(trip["days"], i, images)]
            if len(via) < 2:
                continue
            if store.get(str(day["n"]), {}).get("via") == via:
                continue
            url = OSRM_URL.format(coords=";".join(f"{lon},{lat}" for lon, lat in via))
            result = get_json(url)
            if result.get("code") != "Ok":
                print(f"routes: day {day['n']} failed ({result.get('code')})")
                continue
            line = thin(result["routes"][0]["geometry"]["coordinates"])
            store[str(day["n"])] = {"via": via, "line": line}
            fetched += 1
            time.sleep(1)
    path.write_text(json.dumps(routes, separators=(",", ":")) + "\n")
    print(f"routes: {fetched} fetched")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--refresh", action="store_true", help="fetch everything again")
    args = parser.parse_args()
    trips = load_trips()
    images = build_images(trips, args.refresh)
    build_routes(trips, images, args.refresh)


if __name__ == "__main__":
    main()
