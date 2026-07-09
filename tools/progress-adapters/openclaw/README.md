# OpenClaw Progress Adapter

This adapter converts `muad-progress` event JSON into OpenClaw user-visible tool progress.

It is intentionally thin:

- no business system logic
- no session-manager logic
- no secret handling beyond dropping non-public events

Business skills should call `/usr/local/bin/muad-progress`; OpenClaw runtime code should wire this adapter to the existing `onUpdate` / `emitToolProgress` path.
