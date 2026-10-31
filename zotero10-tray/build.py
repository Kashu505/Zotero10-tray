"""Reproducible XPI/source packaging; Python standard library only."""
from pathlib import Path
import zipfile
import json

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "dist"
OUT.mkdir(exist_ok=True)
manifest = json.loads((ROOT / "addon/manifest.json").read_text())
version = manifest["version"]
for key in ("id", "update_url", "strict_max_version"):
    assert manifest["applications"]["zotero"].get(key), f"Zotero requires {key}"

def archive(path, files):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for src, name in sorted(files, key=lambda p: p[1]):
            info = zipfile.ZipInfo(name, (2026, 10, 31, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, src.read_bytes())
    print(path)

archive(OUT / f"zotero10-tray-{version}.xpi",
        [(p, p.relative_to(ROOT / "addon").as_posix()) for p in (ROOT / "addon").rglob("*") if p.is_file()])
archive(OUT / f"zotero10-tray-{version}-source.zip",
        [(p, "zotero10-tray/" + p.relative_to(ROOT).as_posix()) for p in ROOT.rglob("*")
         if p.is_file() and "__pycache__" not in p.parts])
