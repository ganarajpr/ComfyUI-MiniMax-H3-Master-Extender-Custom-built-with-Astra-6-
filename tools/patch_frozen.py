#!/usr/bin/env python3
"""Edit a vendored (frozen) E4.8 file AND record the edit in e4/PATCHES.json, then refresh e4/MANIFEST.json's hashes.

  patch_frozen.py <e4-relative file> --why "text" --find FILE_WITH_OLD --replace FILE_WITH_NEW

The old text must occur exactly once in the vendored file as it is now. The replacement is appended to that file's list in PATCHES.json (replacements are applied in
order to the source and reversed in the opposite order by e4/verify-frozen.mjs). `--refresh` only recomputes MANIFEST.json's vendoredSha256 for every file.
"""
import argparse, hashlib, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
E4 = ROOT / "e4"


def refresh():
    manifest = json.loads((E4 / "MANIFEST.json").read_text(encoding="utf-8"))
    patches = {p["file"] for p in json.loads((E4 / "PATCHES.json").read_text(encoding="utf-8"))}
    for f in manifest["files"]:
        data = (ROOT / f["path"]).read_bytes()
        f["vendoredSha256"] = hashlib.sha256(data).hexdigest()
        f["patched"] = f["path"][3:] in patches
    (E4 / "MANIFEST.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?")
    ap.add_argument("--why", default="")
    ap.add_argument("--find")
    ap.add_argument("--replace")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    if a.refresh:
        refresh()
        return
    path = E4 / a.file
    text = path.read_bytes().decode("utf-8")
    find = pathlib.Path(a.find).read_text(encoding="utf-8")
    repl = pathlib.Path(a.replace).read_text(encoding="utf-8")
    if text.count(find) != 1:
        raise SystemExit(f"old text found {text.count(find)} times in {a.file}")
    path.write_bytes(text.replace(find, repl).encode("utf-8"))
    patches = json.loads((E4 / "PATCHES.json").read_text(encoding="utf-8"))
    entry = next((p for p in patches if p["file"] == a.file), None)
    if entry is None:
        entry = {"file": a.file, "why": a.why, "replacements": []}
        patches.append(entry)
    elif a.why and a.why not in entry["why"]:
        entry["why"] += " Also: " + a.why
    entry["replacements"].append({"find": find, "replace": repl})
    (E4 / "PATCHES.json").write_text(json.dumps(patches, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    refresh()


if __name__ == "__main__":
    main()
