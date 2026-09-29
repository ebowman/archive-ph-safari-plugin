#!/usr/bin/env python3
"""
Pick the best fallback iPhone simulator to boot from `xcrun simctl list
devices available -j` output (read from stdin).

Selection: among available iPhone devices, prefer the newest iOS runtime
(parsed from the "com.apple.CoreSimulator.SimRuntime.iOS-X-Y" key; other
runtimes such as watchOS/tvOS are skipped). Within the newest runtime,
prefer a device whose name contains "Pro" but not "Max"; otherwise fall
back to the first iPhone found on that runtime.

Prints the chosen device's UDID on stdout (for callers to capture), and a
human-readable "==> Booting <name> (iOS <x.y>, <udid>)" line on stderr.
Prints nothing to stdout and exits 0 if no available iPhone is found (install.sh treats an empty result as the error case).
"""
import json
import sys


def parse_ios_version(runtime_key):
    """Return a tuple of ints for an iOS runtime key, or None if the key
    is not an iOS runtime (e.g. watchOS, tvOS) or is unparsable."""
    marker = "iOS-"
    idx = runtime_key.find(marker)
    if idx == -1:
        return None
    version_str = runtime_key[idx + len(marker):]
    parts = version_str.split("-")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        return None


def select_device(data):
    """Given the parsed JSON dict from `simctl list devices ... -j`,
    return (version_tuple, name, udid) for the chosen device, or None if
    no available iPhone was found."""
    candidates = []  # list of (version_tuple, name, udid)

    for runtime_key, devices in data.get("devices", {}).items():
        version = parse_ios_version(runtime_key)
        if version is None:
            continue
        for d in devices:
            name = d.get("name", "")
            if not name.startswith("iPhone"):
                continue
            if not d.get("isAvailable", True):
                continue
            candidates.append((version, name, d.get("udid", "")))

    if not candidates:
        return None

    newest_version = max(c[0] for c in candidates)
    newest_candidates = [c for c in candidates if c[0] == newest_version]

    for c in newest_candidates:
        name = c[1]
        if "Pro" in name and "Max" not in name:
            return c

    return newest_candidates[0]


def main():
    data = json.load(sys.stdin)
    chosen = select_device(data)
    if chosen is None:
        # Print nothing on stdout; callers (e.g. install.sh) are
        # responsible for treating an empty UDID as "no iPhone found"
        # and reporting their own error.
        return 0

    version, name, udid = chosen
    version_str = ".".join(str(v) for v in version)
    print(f"==> Booting {name} (iOS {version_str}, {udid})", file=sys.stderr)
    print(udid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
