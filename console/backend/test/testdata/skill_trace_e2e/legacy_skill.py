"""Old, unmigrated skill for the TASK-012 compatibility E2E.

It uses ``requests`` directly with manually assembled headers and reads the
legacy session state file (``cookies`` / ``storageState`` only, no
``requestProfile``). It must keep working unchanged after the upgrade: raw
requests are not counted, not limited and produce no ``http`` trace events.
"""

import json
import sys

import requests


def main():
    state_path, base, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
    with open(state_path, encoding="utf-8") as handle:
        state = json.load(handle)
    login = state["platforms"]["mssw"]
    storage_state = login["storageState"]
    headers = {
        "Cookie": login["cookies"],
        "X-Manual-Csrf": login["csrfToken"],
    }
    statuses = []
    for index in range(1, count + 1):
        response = requests.get("%s/legacy/%d" % (base, index), headers=headers, timeout=10)
        statuses.append(response.status_code)
    print(json.dumps({"statuses": statuses, "storageState": storage_state}))


if __name__ == "__main__":
    main()
