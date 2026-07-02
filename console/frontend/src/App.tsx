import { useEffect, useState } from "react";
import { Layout, Nav, Button, Avatar } from "@douyinfe/semi-ui";
import { IconServerStroked, IconComponentStroked, IconSettingStroked, IconSearchStroked } from "@douyinfe/semi-icons";
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

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [page, setPage] = useState<Page>("containers");
  const [user, setUser] = useState<string | null>(null);

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

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  function logout() {
    token.clear();
    setAuthed(false);
  }

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider style={{ width: 220 }}>
        <Nav
          style={{ height: "100%", width: "100%" }}
          defaultSelectedKeys={["containers"]}
          header={{
            logo: <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>muad</span>,
            text: "控制台",
          }}
          footer={{
            collapseButton: false,
          }}
          onClick={(e) => setPage(e.itemKey as Page)}
        >
          {NAV_ITEMS.map((item) => (
            <Nav.Item key={item.key} itemKey={item.key} icon={item.icon} text={item.label} />
          ))}
        </Nav>
        <div style={{ position: "absolute", bottom: 12, left: 12, right: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Avatar size="small">{user?.[0]?.toUpperCase()}</Avatar>
          <span style={{ flex: 1, fontSize: 13, color: "var(--semi-color-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user ?? "..."}</span>
          <NotificationBell />
          <Button size="small" type="tertiary" onClick={logout}>退出</Button>
        </div>
      </Sider>
      <Content style={{ padding: "20px 24px", overflow: "auto", height: "100vh" }}>
        {page === "containers" && <Containers />}
        {page === "llm" && <LLM />}
        {page === "audit" && <Audit />}
        {page === "settings" && <Settings />}
      </Content>
    </Layout>
  );
}
