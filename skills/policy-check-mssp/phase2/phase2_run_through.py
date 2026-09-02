#!/usr/bin/env python3
"""Compatibility entry: execute the Phase 2 one-shot status query only."""

import os
import sys

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SKILL_ROOT not in sys.path:
    sys.path.insert(0, SKILL_ROOT)

from phase2.phase2_wait_check import main


if __name__ == "__main__":
    sys.exit(main())
