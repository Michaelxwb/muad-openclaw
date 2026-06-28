#!/usr/bin/env bash
# 10 天 reaper（控制面 ④）：回收长期不用的用户实例，状态不丢。
# 由 k8s CronJob（reaper-cronjob.yaml）定时调用，或手动跑。
#
# 生命周期（对应设计 RISK 状态分层）：
#   活跃(replicas=1) ──10天无活动──▶ 归档PVC到对象存储 + 缩到0  ──再对话──▶ restore + 拉起
#
# ⚠️ 两处需要你定/补（标 TODO），其余 kubectl 机制已实现：
#   TODO-A 活跃判定来源：当前用"Pod 运行时长"占位。生产应让 worker 在每条消息后
#          打 annotation muad/last-active=<ts>（需在镜像 entrypoint/插件 hook 里加一行），
#          reaper 读它判 10 天。占位方案会误回收"刚起但没人说话"的实例，仅供骨架演示。
#   TODO-B 归档/restore 载体：archive_pvc/restore_pvc 里把状态 tar 到/从对象存储（S3 等）。
#          需要你提供 bucket + 凭证（建议 Secret 注入），命令处已留占位。
set -euo pipefail

NS="${MUAD_NS:-default}"
IDLE_DAYS="${MUAD_IDLE_DAYS:-10}"
DRY_RUN="${DRY_RUN:-true}"   # 默认只报告不动手；设 DRY_RUN=false 真回收

now=$(date +%s)

archive_pvc() {  # $1=user
  echo "  [archive] user=$1 →（TODO-B）把 PVC muad-oc-$1-state 状态 tar 到对象存储"
  # 示例（需补 bucket/凭证）：起一个临时 Job 挂 PVC，tar | aws s3 cp - s3://<bucket>/archive/$1.tar.zst
}
restore_pvc() { echo "  [restore] user=$1 ←（TODO-B）从对象存储恢复 PVC（复活时调用）"; }

# 复活：被回收用户再来消息时由控制面/webhook 调本函数
revive() {  # $1=user
  restore_pvc "$1"
  kubectl -n "${NS}" scale statefulset "muad-oc-$1" --replicas=1
  echo "  [revive] user=$1 已拉起"
}
[[ "${1:-}" == "--revive" ]] && { revive "$2"; exit 0; }

# 扫描所有用户实例
echo "[reaper] ns=${NS} idle_days=${IDLE_DAYS} dry_run=${DRY_RUN}"
kubectl -n "${NS}" get statefulset -l app=muad-openclaw \
  -o jsonpath='{range .items[*]}{.metadata.labels.muad-user}{" "}{.spec.replicas}{" "}{.metadata.annotations.muad/last-active}{"\n"}{end}' \
| while read -r user replicas last_active; do
    [[ -z "${user}" ]] && continue
    [[ "${replicas:-0}" == "0" ]] && continue   # 已回收
    # TODO-A：优先用 annotation muad/last-active；缺失则用 Pod 启动时间占位
    if [[ -n "${last_active}" && "${last_active}" != "<no value>" ]]; then
      idle=$(( (now - last_active) / 86400 ))
    else
      started=$(kubectl -n "${NS}" get pod -l "muad-user=${user}" \
        -o jsonpath='{.items[0].status.startTime}' 2>/dev/null || echo "")
      [[ -n "${started}" ]] && idle=$(( (now - $(date -j -f "%Y-%m-%dT%H:%M:%SZ" "${started}" +%s 2>/dev/null || date -d "${started}" +%s)) / 86400 )) || idle=0
    fi
    # TODO（RULE-06）：再加"无活跃定时任务"判定（读 schedules，见 ⑥），有定时任务的不回收
    if (( idle >= IDLE_DAYS )); then
      echo "→ 回收 user=${user}（空闲 ${idle} 天）"
      if [[ "${DRY_RUN}" == "false" ]]; then
        archive_pvc "${user}"
        kubectl -n "${NS}" scale statefulset "muad-oc-${user}" --replicas=0
      fi
    else
      echo "  保留 user=${user}（空闲 ${idle} 天）"
    fi
  done
