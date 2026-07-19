# OpenClaw Progress Adapter

This adapter converts `muad-progress` event JSON into OpenClaw user-visible tool progress. It is retained as a thin compatibility/PoC adapter; the production OpenClaw path is [`../../muad-run-skill/`](../../muad-run-skill/), which owns the trusted conversation context, delivery, concurrency, and Skill execution audit.

It is intentionally thin:

- no business system logic
- no session-manager logic
- no secret handling beyond dropping non-public events

Business skills should call `/usr/local/bin/muad-progress` from a `muad-run-skill` execution. Do not let a child process or this adapter guess a WeCom/WeChat target, and do not use progress delivery to replace the OpenClaw native final reply.
