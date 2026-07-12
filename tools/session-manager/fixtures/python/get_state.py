#!/usr/bin/env python3
import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    result = subprocess.run(
        ["session-manager", "get-state", "--platform", sys.argv[1]],
        check=False,
        capture_output=True,
        text=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
