# muad-progress

`muad-progress` is a language-neutral CLI used by business skills to report user-visible progress from long-running operations.

The CLI does not own an IM conversation and must not send WeCom/WeChat messages directly. In the OpenClaw runtime, `muad-run-skill` owns the trusted Tool Context, consumes progress events, delivers them to the current conversation, and records them in the Skill execution lifecycle.

It lives under `tools/` because it runs inside worker pods and is not part of the Console control plane. Production images should copy the built binary to:

```text
/usr/local/bin/muad-progress
```

## Build

```bash
go test ./...
go build -o /tmp/muad-progress ./cmd/muad-progress
```

Cross-compile examples:

```bash
GOOS=linux GOARCH=amd64 go build -o dist/muad-progress-linux-amd64 ./cmd/muad-progress
GOOS=linux GOARCH=arm64 go build -o dist/muad-progress-linux-arm64 ./cmd/muad-progress
GOOS=darwin GOARCH=arm64 go build -o dist/muad-progress-darwin-arm64 ./cmd/muad-progress
```

## Usage

```bash
muad-progress stage --stage auth --text "正在检查 XDR 登录态"
muad-progress stage --stage query --text "正在查询 XDR 告警数据"
muad-progress done --text "处理完成，正在生成结果"
```

All user-visible text is validated before delivery. Cookie, token, password, authorization headers, internal URLs, SQL snippets, and stack traces are rejected.

Progress events describe coarse business stages only. They do not replace the OpenClaw native final reply, which remains responsible for the complete text, attachment, image, or card result.

## Adapter

Set `MUAD_PROGRESS_ADAPTER_CMD` to a command that accepts one event JSON object on stdin. If the adapter is missing, the CLI writes a local diagnostic event and exits successfully by default so progress reporting never blocks the business SDK path.

Set `MUAD_PROGRESS_STRICT_ADAPTER=1` to fail when the adapter is unavailable.

OpenClaw business Skills should run through [`../muad-run-skill/`](../muad-run-skill/) instead of wiring a child process directly to an IM channel. The adapter directories remain thin compatibility examples for other Agent runtimes.
