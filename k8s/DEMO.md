# muad 控制台 · K8S 部署实测（OrbStack）

> 2026-06-29 实测验证。控制台 0.1.9 含完整的 K8S Driver (client-go)。

## 集群信息
- **OrbStack** v2.2.1, k8s v1.34.8+orb1, 1 节点 (orbstack control-plane), amd64
- `kubectl context: orbstack`

## 部署步骤（~1 分钟）

```bash
# 1. 启动 OrbStack k8s
orbctl start k8s

# 2. 准备配置（runtime.driver: k8s）
cp console/backend/config.example.yaml workspace/muad_k8s_demo/config.yaml
# 编辑: runtime.driver=k8s, security.masterKey, admin.password, k8s.namespace=muad

# 3. 部署
export KUBECONFIG=$HOME/.orbstack/k8s/config.yml
kubectl --context orbstack create namespace muad
kubectl --context orbstack -n muad create secret generic muad-console-config \
  --from-file=config.yaml=workspace/muad_k8s_demo/config.yaml
kubectl --context orbstack apply -f k8s/console.yaml

# 4. 访问（port-forward 或 Ingress）
kubectl --context orbstack -n muad port-forward svc/muad-console 18080:8080
# http://localhost:18080 登录，创建容器即时生效
```

## 实测结果
| 验证项 | 结果 |
|--------|------|
| console 部署 (SA+RBAC+PVC+Deploy+Svc) | ✅ |
| console 启动 (driver=k8s) | ✅ |
| API 创建 worker → k8s Deploy+PVC+Secret | ✅ |
| worker Pod Running + gateway ready | ✅ |
| 容器列表 API 返回 running | ✅ |

## 关键配置
- console: `runtime.driver: k8s`, `k8s.namespace: muad`, `k8s.stateSize: 3Gi`
- worker: Deployment (1 副本, Recreate 策略), 状态 PVC (RWO), env Secret
- 镜像: console `0.1.9`, worker `0.1.1`

## 清理
```bash
kubectl --context orbstack delete namespace muad
orbctl stop k8s
```
