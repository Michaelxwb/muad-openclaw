#!/usr/bin/env python3
"""Always-failing long task for verifying failure notification.

Exits with code 2 after printing a clear error to stderr. The long-task
runner treats a non-zero exit as failure and should notify the user via IM.
"""

import sys


def main():
    print("error: simulated long task failure", file=sys.stderr)
    print("this task is designed to fail", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
