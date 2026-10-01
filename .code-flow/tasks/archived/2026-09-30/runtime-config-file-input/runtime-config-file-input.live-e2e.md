# 本地真实运行验证（2026-10-01）

用户授权使用本地 dev Console（127.0.0.1:8080）及 orbstack 的 muad/pod01、pod02。测试通过真实 Console HTTP→SQLite→K8s API→Worker，未使用 fake Driver/Store；Docker 验证使用真实 Docker daemon 与 Worker。

## 实测结果

| 编号 | 操作与断言 | 结果 |
|---|---|---|
| LIVE-01 | pod01 原 env/旧镜像通过真实 upgrade API 升级文件镜像；19→20 generation；UID 1000/文件 0440；进程 env 无 DTO；Deployment 无 envFrom/subPath，旧 env Secret DTO key 清理 | 通过：HTTP 200/code 0 |
| LIVE-02 | pod01 实际替换物理 Pod 并重启；file DTO/guard generation 20，guard RPC ok=true；PVC、工作区/会话哨兵、Agent/模型、gateway/service 凭证保持 | 通过 |
| LIVE-03 | pod02 升级可启动但不监听 gateway 的真实不健康镜像；等待真实 health 超时后恢复原镜像和 env；DB/guard/source generation 5；PVC/用户/模型/凭证及哨兵保持 | 通过：HTTP 502/code 50205，实际恢复健康 |
| LIVE-04 | pod02 DELETE deleteState=false→POST 同名/image/adoptState/restoreUsers；原 PVC UID 与卷名不变；旧 runtime generation 5→新记录 generation 2 收敛；原 Human User/Agent/模型与工作区/会话保持；新 gateway/service 凭证，旧 service token HTTP 401 | 通过：创建 HTTP 201/code 0 |
| LIVE-05 | pod02 接管后真实物理重启；file/guard generation 2；两个 Pod 的 Runtime Secret 独立对应各自 Pod ID 与 generation | 通过 |
| LIVE-06 | 独立真实 Docker Worker 读取 141247 bytes 的合法合成 DTO；UID 1000、runtime.json 0600、进程 env 无 DTO、guard 健康；整个目录 readonly bind；原子 rename 后旧 fd 内容保持、新路径读新内容，写入拒绝 EROFS；重启 generation 2 | 通过；临时容器/测试卷已清理 |

测试镜像：muad-openclaw:runtime-file-e2e-20261001（使用仓库 Dockerfile、base 2026.7.1 构建，镜像自检通过）；不健康 fixture：muad-openclaw:runtime-file-unhealthy-20261001（只运行 Node 定时器，能启动但没有 gateway）。未推送 registry。

## 最终环境

- pod01/pod02 都运行新文件输入镜像，Running/Ready 1/1；desired/applied/guard/file generation 分别为 20 与 2；每 Pod 仍有原来的 1 位用户。
- pod01 PVC UID: dc6e6648-3bfc-49d0-b144-1bfc5e9fa17f；pod02 PVC UID: 4d5940fd-1305-4ae5-8b8e-9ca1e59c7ff2；两个 state PVC 及 muad-skills 均保留。
- 同名重建使用了原创建参数的通道/资源设置；pod02 新凭证符合新逻辑 Pod 语义。
- 测试自己的工作区/会话 marker 已删除，原用户内容未删除；Docker临时容器/状态卷已清理。
- 数据库一致性备份、原 Deployment/Secret/PVC 与原创建参数保存在 /tmp/muad-runtime-live-e2e-20261001，目录 0700、敏感文件 0600，不进入仓库。不要把此目录上传或复制进镜像。

## 命令及范围

实际执行脚本：/tmp/muad-runtime-live-e2e-20261001/live_probe.py、rollback_probe.py、adoption_probe.py（用户详情解包修正后复核）、restart_probe.py、adopted_restart_probe.py、docker_probe.py；原 API 响应及结构化结果在同一私有目录。Docker >128 KiB 使用合法 guidance 长文本与 main agent 合成，证明实际入口避开 env exec 限制，**不冒充 B-01 的 10 用户+传统脚本完整场景**。

本轮为用户授权的现有 Pod 实测，覆盖升级/回滚/接管与独立 Docker 启动源边界。并未执行注册矩阵的所有原始测试命令，也未覆盖 Docker Console 完整生命周期、两用户私有 Skill/长任务、10 用户传统脚本大型 DTO、Console abrupt crash、传播延迟/并发全矩阵。因此原清单的这些 E2E 状态继续 deferred；S-02 的独立已执行结果保留 verified。正式需求级 verified 仍需专用环境及 17 项 review 确认，不以本报告替代。

实测发现并修复的测试辅助缺陷：GET/PATCH Human User 响应位于 data.humanUser；PATCH 字段是 prompt。追加 TASK-021/S-22，通过真实 HTTP/SQLite 契约回归与 tagged E2E 编译/vet，未改变产品 API。

## 用户确认收尾

2026-10-01，用户明确不再补测 Docker 和 10 用户规模场景，随后指示：“我手动验证了基本可用，那就直接归档任务”。按用户要求结束本轮验证并归档。此人工结论不扩大为所有异常场景或全部规范逐项通过；上文实测结果、未测范围及原始 deferred 状态保留。
