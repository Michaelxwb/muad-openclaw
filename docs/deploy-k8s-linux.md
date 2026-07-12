# muad 测试环境部署（Linux + K8S）

> 全新 Linux 服务器，k3s 轻量 K8S，muad console 自管 worker。

## 1. 机器要求

- **OS**：Ubuntu 22.04+ / Debian 12+ / CentOS 9+（amd64）
- **规格**：最低 4 vCPU / 8 GiB / 50 GB SSD
- **端口**：放行 18080（控制台），需出站访问 api.deepseek.com 等 LLM 端点

## 2. 装 K8S（k3s）

```bash
# 一行装好 k3s（自带 kubectl、containerd、local-path 存储）
curl -sfL https://get.k3s.io | sh

# 等就绪
sudo k3s kubectl get nodes   # 应显示 Ready

# 方便 root 用 kubectl（非 root 跳过）
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
alias k="kubectl"
```

> k3s 自带 `local-path-provisioner`，PVC 自动创建——不需要额外配存储。

## 3. 准备 muad

```bash
# 在你的本机（有仓库的那台），把 k8s/ 目录和 config 模板传到服务器
scp -r k8s/ user@server:~/muad/
# 然后 ssh 到服务器
ssh user@server
```

```bash
cd ~/muad

# 3.1 写配置文件
cat > config.yaml << 'EOF'
runtimeDriver: k8s
masterKey: "<生成: openssl rand -hex 32>"
adminUser: admin
adminPassword: "<你的密码>"
defaultImage: ghcr.io/michaelxwb/muad-openclaw:0.1.1
k8sNamespace: muad
k8sStateSize: 3Gi
collectIntervalSec: 30
logDir: /var/lib/muad-console/logs
listenAddr: ":8080"
dbPath: /var/lib/muad-console/console.db
EOF

# 3.2 部署
kubectl create namespace muad
kubectl -n muad create secret generic muad-console-config --from-file=config.yaml
# 把 console 的 Deployment 镜像改成最新版
sed 's|image: ghcr.io/michaelxwb/muad-console:latest|image: ghcr.io/michaelxwb/muad-console:0.1.9|' k8s/console.yaml | kubectl apply -f -

# 3.3 等就绪
kubectl -n muad get pods -w    # Ctrl+C 退出
```

## 4. 访问控制台

```bash
# 方式 A：port-forward（开发用）
kubectl -n muad port-forward svc/muad-console 18080:8080 &
# → http://<服务器IP>:18080

# 方式 B：NodePort（固定端口）
kubectl -n muad patch svc muad-console -p '{"spec":{"type":"NodePort","ports":[{"port":8080,"nodePort":30080}]}}'
# → http://<服务器IP>:30080
```

## 5. 使用

打开浏览器 → 登录页 → `admin` / 你设的密码 → 创建容器。

创建容器后验证：
```bash
kubectl -n muad get deploy,pvc,secret,pods -l app=muad-oc
```

## 6. 清理

```bash
kubectl delete namespace muad    # 删全部资源
# 或用 k3s 自带的卸载
/usr/local/bin/k3s-uninstall.sh  # 彻底卸载 k3s
```

---

*当前最新镜像：console `0.1.9`，worker `0.1.1`。*
