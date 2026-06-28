# muad-console frontend

React + Vite SPA (admin/monitoring UI). Created by TASK-018.

Build output is embedded into the Go binary (`console/backend`) at image build
time (multi-stage Dockerfile, design §4.2): `vite build` → `go:embed` →
distroless runtime.

> Placeholder — scaffolding lands in TASK-018.
