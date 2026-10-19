# tools/dev

Local development helpers; not installed into the app image.

## `bin/session-manager`

A stand-in for the runtime `session-manager` command. The skill SDK calls
`session-manager get-state --skill-name <name>` and reads the returned
`sessionStateFile`; this shim returns a local state file instead of contacting
Console.

```bash
export PATH="$PWD/tools/dev/bin:$PATH"
export MUAD_LOCAL_SESSION_STATE="$HOME/muad-local/mssw.json"
export MUAD_SKILL_NAME=<skill-name>
python3 scripts/run.py
```

The shim also accepts an explicit `--file <path>`. It validates that the file
exists and contains JSON, but it does not read or log cookies.

## `local-state.example.json`

Template for the local session state file: one `platforms.<name>` section per
platform, with `cookies`, `storageState` and `requestProfile`. Replace all
placeholders with a real session for the business environment under test and
never commit the filled-in file.
