"""Shared constants for the MSSW platform smoke skill."""

import json
import os
import subprocess

# Must match skills/mssw-platform-smoke/muad.skill.json platforms.
PLATFORM = "mssw"
SKILL_NAME = "mssw-platform-smoke"
PING_PATH = "/api/v1/ping"
TARGETS_PATH = "/api/v1/targets"
# The probe is a smoke test, not an arbitrary interface scanner.
ALLOWED_PATHS = (PING_PATH, TARGETS_PATH)
MAX_PROBE_COUNT = 50
DEFAULT_PROBE_COUNT = 4
EXIT_NOT_SKILL_EXECUTION = 4
# Local development only; pods have MUAD_SESSION_KEY and use session-manager.
LOCAL_STATE_FILE = os.path.expanduser("~/.muad-local/session-state.json")


class SkillExecutionRequired(RuntimeError):
    """Raised when the scripts run outside a guard-injected Skill execution."""


def require_skill_execution():
    """Fail fast unless the guard injected this Skill's name into exec env.

    The guard only resolves ``MUAD_SKILL_NAME`` for an activated Skill, so a
    plain shell invocation cannot reach the platform request path by accident.
    """
    actual = str(os.environ.get("MUAD_SKILL_NAME", "")).strip()
    if actual == SKILL_NAME:
        return
    raise SkillExecutionRequired(
        "%s must run through Skill execution: activate the Skill first "
        "(read SKILL.md or use /skill:%s); MUAD_SKILL_NAME=%r"
        % (SKILL_NAME, SKILL_NAME, actual or None)
    )


def resolve_state_file():
    """Resolve this Skill's session state through session-manager.

    Local development only: when MUAD_SESSION_KEY is absent, an existing
    ~/.muad-local/session-state.json is used instead of requiring session-manager.
    """
    if not os.environ.get("MUAD_SESSION_KEY") and os.path.isfile(LOCAL_STATE_FILE):
        return LOCAL_STATE_FILE
    try:
        completed = subprocess.run(
            ["session-manager", "get-state", "--skill-name", SKILL_NAME],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("session-manager could not run: %s" % error)
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip().splitlines()
        raise RuntimeError(
            "session-manager get-state failed: %s"
            % (detail[0][:200] if detail else "exit %d" % completed.returncode)
        )
    try:
        return json.loads(completed.stdout)["sessionStateFile"]
    except (ValueError, KeyError, TypeError) as error:
        raise RuntimeError("session-manager output is invalid: %s" % error)

