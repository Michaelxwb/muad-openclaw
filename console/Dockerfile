# muad 控制台镜像（多阶段，§4.2）：
#   ① node 阶段 vite build 前端 → ② golang 阶段 go build 内嵌前端(-tags prod)
#   → ③ alpine runtime（带 docker CLI，供 DockerDriver 调用）。
# 镜像不烤任何凭证：主密钥/管理员初值/driver 全在运行时只读挂载的 config.yaml（NFR-SEC-02）。

# ① 前端
FROM node:24-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build   # → /fe/dist

# ② 后端（内嵌前端产物）
FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=frontend /fe/dist ./internal/web/dist
RUN CGO_ENABLED=0 go build -tags prod -ldflags="-s -w" -o /muad-console ./cmd/console

# ③ 运行时（docker CLI 供 DockerDriver；以 root 运行——持有 docker.sock 本即 root 等价，
#    见 RISK-03。k8s 形态用 k8s driver 不需 docker.sock，可在编排层覆盖为非 root。）
FROM alpine:3.20
RUN apk add --no-cache docker-cli ca-certificates tzdata
COPY --from=backend /muad-console /usr/local/bin/muad-console
# 不烤 CONSOLE_* 配置 env：env > yaml 会反向覆盖 config.yaml；listenAddr/dbPath 由
# config.yaml 或内置默认值提供。仅留 TZ（OS 级，非配置字段）。
ENV TZ=Asia/Shanghai
VOLUME /var/lib/muad-console
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/muad-console"]
