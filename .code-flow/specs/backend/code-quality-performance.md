---
description: 写后端代码时适用：错误处理、测试、超时重试、缓存等质量与性能约束
---

# Backend Code Quality & Performance

## Examples

> ✅/❌ 对照示例对 AI 的引导远强于规则条文——新写规范优先用这个格式（cf-learn 候选会自动生成草稿）。

✅ 显式错误处理

```python
try:
    result = service.call()
except ServiceError as exc:
    logger.warning("call failed: %s", exc)
    raise
```

❌ 静默吞异常

```python
try:
    result = service.call()
except Exception:
    pass
```


## Rules
- 所有公开函数 / 方法必须有类型注解（type hints / 类型签名）
- 异常必须显式处理或显式上抛，禁止 `except Exception: pass` / `catch (e) {}` 静默吞掉
- 外部依赖调用（HTTP / RPC / DB）必须设置超时，关键调用补重试 + 指数退避
- 单元测试覆盖核心业务路径：happy path + 边界 + 错误分支，每个需求 ≥ 1 个用例
- **[项目] 容器外部命令（docker CLI / kubectl）必须包 driver 内部 helper**：`internal/driver/{docker,k8s}.go` 内 `d.run` / `d.runStdin` 统一做 `exec.CommandContext` + stderr 合并到 error + 错误包装（`fmt.Errorf("docker %s: %w: %s", args[0], err, stderr)`）；业务代码（任何其他包）禁止直接 `exec.Command("docker", ...)`，必须通过 `RuntimeDriver` 接口 + driver 内部 helper 调。新增 driver 实现（podman / nerdctl 等）必须自带等效 `run` / `runStdin` helper，保持 stderr 合并与错误格式一致。

## Patterns
- 缓存可计算结果以减少重复 IO，明确缓存 key、TTL 与失效策略
- 重 IO 用异步或批处理，CPU 密集任务下沉到 worker / 队列
- 资源（连接、文件、锁）使用 `with` / `using` / `defer` 确保释放
- 性能敏感路径加监控指标（QPS / P95 延迟 / 错误率）

## Anti-Patterns
- 禁止在请求链路中吞掉异常导致客户端拿到错误结果却无日志
- 禁止无超时的外部调用（容易导致线程 / 协程泄漏）
- 禁止用循环模拟批量操作（DB 批量 / 网络批量必须用原生批量 API）
- 禁止把缓存失败当致命错误，缓存层必须可降级为直接查询

## Project-Specific Patterns

> 以下从项目代码中提取。

- **[cmd/console/main.go]** HTTP Server 必须设置 `ReadHeaderTimeout`，优雅关闭用 `signal.NotifyContext` + `srv.Shutdown`
- **[internal/config/config.go]** 配置加载优先级：env > yaml > defaults；密钥（密码、token）**仅从环境变量注入**，不入 yaml 文件
- **[internal/repo/repo.go]** 数据访问集中到 `repo` 包，handler 不直接操作 DB
- **[internal/driver/]** 容器运行时通过 `Driver` 接口抽象（Docker / K8s 双实现），`factory.go` 按配置选择驱动
- **[test/]** 测试文件放 `test/` 目录（非 `internal/*/` 内），集成测试风格
- **[test/api_test.go]** 测试使用 fake/mock 实现接口替代真实依赖（`fakeDriver` 实现 `RuntimeDriver` 接口），结合 `httptest` 测试完整 HTTP handler 链路；测试命名：`Test<Component>_<Scenario>`
- **[internal/crypto/crypto.go:68-73]** 敏感字段展示前必须脱敏：`crypto.Mask()` 保留 4 字符前缀，其余替换为 `****`；日志/UI/审计中禁止输出完整 token/secret/API key
- **[internal/collector/collector.go]** 后台采集循环：worker pool（16 goroutines）+ per-task timeout（3s）+ atomic cache swap；单容器故障不阻塞整个采集周期，stuck probe 超时自动跳过
- **[internal/gateway/probe.go, console/README.md]** 容器内 openclaw 探针用 `openclaw channels status --json`，**不要**用 `openclaw status --json`——后者请求 `system-presence` 需 `operator.read` scope，token 连接无此 scope 会每个采集周期刷 `missing scope: operator.read` 错误日志（gateway.auth 无 scopes 配置项，无法授权）。channel-status 字段**因通道插件而异**，解析须兼容多形态：企微 `running/lastStartAt`，微信 `lastInboundAt/lastOutboundAt`（最后活跃取三者最大值，连接判断取 `running || configured || 有账号`）
- **[tools/muad-progress/internal/skillcheck/check.go]** 业务系统类 skill（如 XDR / SOAR / MSS / SDSP / `platform=`）必须接入 `muad-progress`，并在 `SKILL.md` 或脚本中体现 `session-manager` 使用约定。新增或修改这类 skill 后，至少运行 `muad-skill-check` 或对应单元测试，确保没有绕过进度与登录态规范。
