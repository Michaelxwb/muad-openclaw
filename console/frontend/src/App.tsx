import { useEffect, useState } from "react";
import { Layout, Nav, Button, Avatar } from "@douyinfe/semi-ui";
import { IconServerStroked, IconComponentStroked, IconSettingStroked, IconSearchStroked, IconMoon, IconSun, IconExit } from "@douyinfe/semi-icons";
import { api, token, UNAUTHORIZED_EVENT } from "./api";
import { Containers } from "./pages/Containers";
import { LLM } from "./pages/LLM";
import { Audit } from "./pages/Audit";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import { NotificationBell } from "./components/NotificationBell";

const { Sider, Content } = Layout;

type Page = "containers" | "llm" | "audit" | "settings";

const NAV_ITEMS: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: "containers", label: "容器", icon: <IconServerStroked size="large" /> },
  { key: "llm", label: "模型配置", icon: <IconComponentStroked size="large" /> },
  { key: "settings", label: "资源配置", icon: <IconSettingStroked size="large" /> },
  { key: "audit", label: "审计日志", icon: <IconSearchStroked size="large" /> },
];

// 暗色主题 CSS——直接覆盖 Semi 组件 class（Semi 变量走 :host Shadow DOM，
// 普通 DOM 下注入 :root 变量不生效，必须针对具体组件类覆写）。
const DARK_CSS = `
/* 全局 */
html, body, #root {
  background: #0a0e14 !important;
  color: rgba(255,255,255,0.85) !important;
}

/* 布局 */
.semi-layout { background: #0a0e14 !important; }
.semi-layout-sider { background: #11151d !important; border-right-color: rgba(255,255,255,0.06) !important; }

/* 导航 */
.semi-navigation { background: #11151d !important; }
.semi-navigation-header { border-bottom: 1px solid rgba(255,255,255,0.06) !important; padding-bottom: 12px !important; margin-bottom: 8px !important; }
.semi-navigation-item {
  color: rgba(255,255,255,0.60) !important;
  padding: 10px 20px !important;
  margin: 2px 8px !important;
  border-radius: 6px !important;
  border-left: 3px solid transparent !important;
  transition: all 0.15s !important;
}
.semi-navigation-item:hover { background: rgba(255,255,255,0.05) !important; color: rgba(255,255,255,0.90) !important; border-left-color: rgba(255,255,255,0.15) !important; }
.semi-navigation-item-active, .semi-navigation-item-active:hover {
  background: linear-gradient(90deg, rgba(0,229,255,0.12), rgba(0,229,255,0.02)) !important;
  color: rgba(255,255,255,0.95) !important;
  border-left-color: #00e5ff !important;
}
.semi-navigation-item .semi-navigation-item-icon { font-size: 20px !important; color: rgba(255,255,255,0.70) !important; }
.semi-navigation-item-active .semi-navigation-item-icon { color: rgba(255,255,255,0.95) !important; }

/* 表格 */
.semi-table-thead>.semi-table-row>.semi-table-row-head {
  background-color: #151b28 !important; color: rgba(255,255,255,0.65) !important;
  border-bottom-color: rgba(255,255,255,0.08) !important;
}
.semi-table-tbody>.semi-table-row>.semi-table-row-cell {
  background-color: #12161e !important; color: rgba(255,255,255,0.85) !important;
  border-bottom-color: rgba(255,255,255,0.04) !important;
  transition: background-color 0.15s ease !important;
}
.semi-table-tbody>.semi-table-row:hover>.semi-table-row-cell {
  background-color: #181c28 !important;
}
.semi-table-empty .semi-table-tbody>tr>td {
  background-color: #12161e !important;
}

/* 输入框 */
.semi-input-wrapper, .semi-input {
  background-color: #151b28 !important;
  border-color: rgba(255,255,255,0.10) !important;
  color: rgba(255,255,255,0.85) !important;
}
.semi-input-wrapper:hover { border-color: rgba(255,255,255,0.18) !important; }
.semi-input-wrapper-focus { border-color: rgba(0,229,255,0.4) !important; }

/* 下拉 */
.semi-select { background: #151b28 !important; box-shadow: none !important; }
.semi-select:hover { background: #151b28 !important; }
.semi-select-focus { border-color: rgba(0,229,255,0.4) !important; box-shadow: none !important; }
.semi-select-selection {
  background: transparent !important;
  border: none !important;
  color: rgba(255,255,255,0.85) !important;
  box-shadow: none !important;
}
.semi-select-selection:hover { border: none !important; box-shadow: none !important; }
.semi-select-option-list-wrapper {
  background: #181c28 !important; border-color: rgba(255,255,255,0.08) !important;
}
.semi-select-option { color: rgba(255,255,255,0.85) !important; }
.semi-select-option:hover { background: rgba(255,255,255,0.06) !important; }
.semi-select-option-selected { color: rgba(0,229,255,1) !important; }

/* 按钮（保持 Semi 默认，仅微调） */
.semi-button-tertiary { color: rgba(255,255,255,0.60) !important; }
.semi-button-tertiary:hover { color: rgba(255,255,255,0.85) !important; }

/* 模态弹窗 */
.semi-modal-content { background: #151b28 !important; border: 1px solid rgba(255,255,255,0.06) !important; border-radius: 8px !important; }
.semi-modal-header { border-bottom-color: rgba(255,255,255,0.06) !important; font-size: 16px !important; font-weight: 600 !important; }
.semi-modal-footer { border-top-color: rgba(255,255,255,0.06) !important; }

/* 通知铃铛脉冲 */
@keyframes muadBellPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
.semi-badge-count { animation: muadBellPulse 2s ease-in-out infinite; }

/* 卡片 */
.semi-card { background: #11151d !important; border-color: rgba(255,255,255,0.06) !important; }

/* Tag */
.semi-tag { border: none !important; }

/* 弹出层 */
.semi-popover { background: #181c28 !important; border-color: rgba(255,255,255,0.08) !important; }

/* 表单文字 */
.semi-form-label { color: rgba(255,255,255,0.60) !important; }
`;

const THEME_KEY = "muad_theme";

// 注入 / 移除暗色主题 style 标签
function applyTheme(mode: "dark" | "light") {
  document.body.setAttribute("theme-mode", mode);
  const id = "muad-theme";
  const existing = document.getElementById(id);
  if (mode === "dark" && !existing) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = DARK_CSS;
    document.head.appendChild(s);
  } else if (mode === "light" && existing) {
    existing.remove();
  }
}

function savedTheme(): "dark" | "light" {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* noop */ }
  return "dark"; // 默认暗色
}

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [page, setPage] = useState<Page>("containers");
  const [user, setUser] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(savedTheme);
  const [collapsed, setCollapsed] = useState(false);

  // 登录页也暗色
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  useEffect(() => {
    if (authed) {
      api.me().then((d) => setUser(d.actor)).catch(() => {});
    }
  }, [authed]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* noop */ }
  }

  if (!authed) {
    return (
      <>
        <Login onLogin={() => setAuthed(true)} />
        {/* 登录页也显示主题切换 */}
        <div style={{ position: "fixed", top: 16, right: 16, zIndex: 999 }}>
          <Button
            icon={theme === "dark" ? <IconMoon /> : <IconSun />}
            theme="borderless"
            size="small"
            onClick={toggleTheme}
          />
        </div>
      </>
    );
  }

  function logout() {
    token.clear();
    setAuthed(false);
  }

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider style={{ width: collapsed ? 60 : 180, transition: "width 0.2s" }}>
        {collapsed && (
          <div style={{ display: "flex", justifyContent: "center", padding: "5px 0 2px" }}>
            <Button icon={<span style={{ fontSize: 16 }}>▶</span>} theme="borderless" size="small" onClick={() => setCollapsed(false)} />
          </div>
        )}
        <Nav
          style={{ height: collapsed ? "calc(100% - 36px)" : "100%", width: "100%", overflow: "hidden" }}
          defaultSelectedKeys={["containers"]}
          isCollapsed={collapsed}
          header={collapsed ? undefined : {
            logo: (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <rect width="24" height="24" rx="5" fill="rgba(0,229,255,0.15)" />
                  <path d="M7 8h10M7 12h10M7 16h6" stroke="#00e5ff" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>muad</span>
              </div>
            ),
            text: (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>控制台</span>
                <Button icon={<span>◀</span>} theme="borderless" size="small" onClick={() => setCollapsed(true)} />
              </div>
            ),
          }}
          footer={{ collapseButton: false }}
          onClick={(e) => setPage(e.itemKey as Page)}
        >
          {NAV_ITEMS.map((item) => (
            <Nav.Item key={item.key} itemKey={item.key} icon={item.icon} text={item.label} />
          ))}
        </Nav>
        <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, display: "flex", flexDirection: collapsed ? "column" : "row", alignItems: "center", gap: collapsed ? 4 : 6, padding: collapsed ? "6px 0 0" : "10px 12px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <Avatar size="extra-small">{user?.[0]?.toUpperCase()}</Avatar>
          {!collapsed && <span style={{ flex: 1, fontSize: 13, color: "var(--semi-color-text-2)" }}>{user ?? "..."}</span>}
          {collapsed
            ? <Button size="small" type="tertiary" onClick={logout} theme="borderless" icon={<IconExit />} />
            : <Button size="small" type="tertiary" onClick={logout} theme="borderless">退出</Button>
          }
        </div>
      </Sider>
      <Content style={{ padding: "10px 24px 20px", overflow: "auto", height: "100vh" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <Button size="small" icon={theme === "dark" ? <IconMoon /> : <IconSun />} type="tertiary" onClick={toggleTheme} theme="borderless" />
          <NotificationBell />
        </div>
        {page === "containers" && <Containers />}
        {page === "llm" && <LLM />}
        {page === "audit" && <Audit />}
        {page === "settings" && <Settings />}
      </Content>
    </Layout>
  );
}
