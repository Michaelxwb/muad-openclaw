# Muad Runtime Guard

The `main` agent is reserved for identity activation. A `before_agent_reply`
hook claims every normal `main` turn before model execution and returns binding
guidance. The unauthenticated `/bind` command remains the only activation path;
configured business agents continue through the normal model path.

`muad-runtime-guard` is an external OpenClaw plugin. It does not patch OpenClaw.

It registers:

- `/bind <code>` with `acceptsArgs: true` and `requireAuth: false`.
- `muad.runtime.health` with the `operator.read` Gateway scope.

The bind handler accepts only direct messages routed to `main` on WeCom or
WeChat. Sender, channel, account, agent, and session values come from the
trusted OpenClaw command context. The only user argument is the short-lived
binding code. Every command result sets `continueAgent: false`, so the command
is consumed without a second model-generated reply.

The plugin reads the Pod service token from
`/run/secrets/muad/pod-service-token` for each activation request. Binding codes
and tokens are never included in logs, errors, or health output.

Runtime health is true only when the Runtime DTO generation is valid, the
agent/profile and session-agent mappings match, session-manager is loaded, and
the shared Skill queue is available. The manifest declares the Browser, main,
and agent-files trusted policies implemented by the Runtime Guard.
