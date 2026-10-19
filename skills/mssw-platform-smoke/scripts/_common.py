"""Shared constants for the MSSW platform smoke skill."""

import os

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

