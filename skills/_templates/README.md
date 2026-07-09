# Skill Templates

Templates in this directory show the required progress-aware pattern for long-running business skills.

Rules:

- call `muad-progress` for accepted/auth/query/analysis/done/error stages
- call session-manager for business login state before touching protected systems
- never place Cookie, token, password, internal URLs, SQL, or stack traces in progress text
- keep progress text short and user-facing
