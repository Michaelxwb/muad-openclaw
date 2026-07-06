import { useEffect, useState } from "react";
import { Layout, Nav, Button, Avatar } from "@douyinfe/semi-ui";
import {
  IconServerStroked,
  IconComponentStroked,
  IconSettingStroked,
  IconSearchStroked,
  IconMoon,
  IconSun,
  IconExit,
} from "@douyinfe/semi-icons";
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

// 暗色主题：让 Semi 内建主题接管——只需把 theme-mode 写到 body 上，
// Semi 在 base.css 里已经按 `body[theme-mode=dark]` 重定义所有 CSS 变量，
// 组件（Nav/Layout/Table/Input/...）自动跟随，无需手写 `!important` 覆盖。
const THEME_KEY = "muad_theme";

function applyTheme(mode: "dark" | "light") {
  document.body.setAttribute("theme-mode", mode);
}

function savedTheme(): "dark" | "light" {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* noop */
  }
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
      api
        .me()
        .then((d) => setUser(d.actor))
        .catch(() => {});
    }
  }, [authed]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* noop */
    }
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
            <Button
              icon={<span style={{ fontSize: 16 }}>▶</span>}
              theme="borderless"
              size="small"
              onClick={() => setCollapsed(false)}
            />
          </div>
        )}
        <Nav
          style={{
            height: collapsed ? "calc(100% - 36px)" : "100%",
            width: "100%",
            overflow: "hidden",
          }}
          defaultSelectedKeys={["containers"]}
          isCollapsed={collapsed}
          header={
            collapsed
              ? undefined
              : {
                  logo: (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <rect width="24" height="24" rx="5" fill="rgba(0,229,255,0.15)" />
                        <path
                          d="M7 8h10M7 12h10M7 16h6"
                          stroke="#00e5ff"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>muad</span>
                    </div>
                  ),
                  text: (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>控制台</span>
                      <Button
                        icon={<span>◀</span>}
                        theme="borderless"
                        size="small"
                        onClick={() => setCollapsed(true)}
                      />
                    </div>
                  ),
                }
          }
          footer={{ collapseButton: false }}
          onClick={(e) => setPage(e.itemKey as Page)}
        >
          {NAV_ITEMS.map((item) => (
            <Nav.Item key={item.key} itemKey={item.key} icon={item.icon} text={item.label} />
          ))}
        </Nav>
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: collapsed ? "column" : "row",
            alignItems: "center",
            gap: collapsed ? 4 : 6,
            padding: collapsed ? "6px 0 0" : "10px 12px 0",
            borderTop: `1px solid ${theme === "dark" ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"}`,
          }}
        >
          <Avatar size="extra-small">{user?.[0]?.toUpperCase()}</Avatar>
          {!collapsed && (
            <span style={{ flex: 1, fontSize: 13, color: "var(--semi-color-text-2)" }}>
              {user ?? "..."}
            </span>
          )}
          {collapsed ? (
            <Button
              size="small"
              type="tertiary"
              onClick={logout}
              theme="borderless"
              icon={<IconExit />}
            />
          ) : (
            <Button size="small" type="tertiary" onClick={logout} theme="borderless">
              退出
            </Button>
          )}
        </div>
      </Sider>
      <Content style={{ padding: "10px 24px 20px", overflow: "auto", height: "100vh" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 4,
            marginBottom: 4,
          }}
        >
          <Button
            size="small"
            icon={theme === "dark" ? <IconMoon /> : <IconSun />}
            type="tertiary"
            onClick={toggleTheme}
            theme="borderless"
          />
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
