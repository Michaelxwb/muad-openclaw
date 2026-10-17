"""Real skill script for the TASK-012 cross-boundary E2E.

Every business request goes through the shipped ``muad_skill_http`` helper, so
the run exercises the real SDK: per-interface counting, limit termination
(``os._exit(86)``) and the JSONL trace spool read by the runtime guard.

Usage: helper_skill.py <base-url> <request-count> <path-prefix>
"""

import json
import sys

import muad_skill_http


def main():
    base, count, prefix = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    statuses = []
    for index in range(1, count + 1):
        response = muad_skill_http.get(
            "%s%s/%d" % (base, prefix, index),
            # Deliberately sensitive values: the trace must never contain them.
            headers={"X-E2E-Secret-Header": "e2e-secret-header"},
            json={"secret": "e2e-secret-body"},
            timeout=10,
        )
        statuses.append(response.status_code)
    muad_skill_http._flush_summary()
    print(json.dumps({"statuses": statuses}))


if __name__ == "__main__":
    main()
