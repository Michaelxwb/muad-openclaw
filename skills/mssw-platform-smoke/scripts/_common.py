"""Shared constants for the MSSW platform smoke skill."""

# Must match skills/mssw-platform-smoke/muad.skill.json platforms.
PLATFORM = "mssw"
PING_PATH = "/api/v1/ping"
TARGETS_PATH = "/api/v1/targets"
# The probe is a smoke test, not an arbitrary interface scanner.
ALLOWED_PATHS = (PING_PATH, TARGETS_PATH)
MAX_PROBE_COUNT = 50
DEFAULT_PROBE_COUNT = 4
