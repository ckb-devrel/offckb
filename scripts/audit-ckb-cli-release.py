#!/usr/bin/env python3
"""Explicit maintainer audit; never invoked by installation or command execution.

Run from the repository root with an output directory inside this worktree.
Downloads every platform in tools/ckb-cli.json, verifies bytes and regular-file
members, and records archive notices. Does not execute any downloaded program.
"""

import hashlib
import json
from pathlib import Path
import sys
import tarfile
import urllib.request
import zipfile


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/audit-ckb-cli-release.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    descriptor = json.loads(Path("tools/ckb-cli.json").read_text())
    results = []
    for platform, asset in descriptor["platforms"].items():
        archive = output / asset["url"].rsplit("/", 1)[1]
        with urllib.request.urlopen(asset["url"], timeout=120) as response:
            archive.write_bytes(response.read())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != asset["sha256"]:
            raise ValueError(f"{platform}: SHA-256 mismatch: {digest}")
        notice_member = asset["executable"].rsplit("/", 1)[0] + "/COPYING"
        if asset["format"] == "zip":
            with zipfile.ZipFile(archive) as packed:
                member = packed.getinfo(asset["executable"])
                mode = member.external_attr >> 16
                if member.is_dir() or (mode & 0o170000) not in (0, 0o100000):
                    raise ValueError(f"{platform}: executable is not a regular file")
                notice = packed.read(notice_member)
        elif asset["format"] == "tar.gz":
            with tarfile.open(archive) as packed:
                if not packed.getmember(asset["executable"]).isfile():
                    raise ValueError(f"{platform}: executable is not a regular file")
                if not packed.getmember(notice_member).isfile():
                    raise ValueError(f"{platform}: COPYING is not a regular file")
                notice = packed.extractfile(notice_member).read()
        else:
            raise ValueError(f"{platform}: unsupported audit format")
        (output / f"{platform}-COPYING").write_bytes(notice)
        results.append({"platform": platform, **asset, "notice": notice_member})
        print(f"PASS {platform}: SHA-256, executable member, COPYING")
    (output / "archive-audit.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
