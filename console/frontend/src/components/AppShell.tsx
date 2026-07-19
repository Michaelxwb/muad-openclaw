import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@douyinfe/semi-ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconComponentStroked,
  IconExit,
  IconPuzzle,
  IconSearchStroked,
  IconServerStroked,
  IconSettingStroked,
  IconUserGroup,
} from "@douyinfe/semi-icons";
import { api } from "../api";
import { Audit } from "../pages/Audit";
import { Containers } from "../pages/Containers";
import { LLM } from "../pages/LLM";
import { PodDetail } from "../pages/PodDetail";
import { Settings } from "../pages/Settings";
import { Skills } from "../pages/Skills";
import { Users } from "../pages/Users";
import { NotificationBell } from "./NotificationBell";
import { ThemeButton } from "./ThemeButton";
import type { ThemeMode } from "./ThemeButton";
import styles from "./AppShell.module.css";

type Page = "pods" | "users" | "skills" | "llm" | "settings" | "audit";

const PAGE_KEY = "muad_console_page";

const NAV_ITEMS: { key: Page; label: string; icon: ReactNode }[] = [
  { key: "pods", label: "Pod 管理", icon: <IconServerStroked size="large" /> },
  { key: "users", label: "用户管理", icon: <IconUserGroup size="large" /> },
  { key: "skills", label: "Skill 管理", icon: <IconPuzzle size="large" /> },
  { key: "llm", label: "模型配置", icon: <IconComponentStroked size="large" /> },
  { key: "settings", label: "资源与平台", icon: <IconSettingStroked size="large" /> },
  { key: "audit", label: "审计日志", icon: <IconSearchStroked size="large" /> },
];

interface Props {
  theme: ThemeMode;
  onTheme: () => void;
  onLogout: () => void;
}

export function AppShell({ theme, onTheme, onLogout }: Props) {
  const [page, setPage] = useState<Page>(readInitialPage);
  const [detailPodId, setDetailPodId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useResponsiveSidebar();
  const user = useCurrentUser();
  const changePage = (next: Page) => {
    setDetailPodId(null);
    setPage(next);
    writePage(next);
  };
  const openPodDetail = (podId: string) => {
    setDetailPodId(podId);
    setPage("pods");
    writePage("pods");
  };
  const closePodDetail = () => setDetailPodId(null);
  return (
    <div className={styles.layout}>
      <AppSidebar
        page={page}
        user={user}
        collapsed={collapsed}
        onPage={changePage}
        onCollapsed={setCollapsed}
        onLogout={onLogout}
      />
      <main className={styles.content}>
        <div className={styles.topbar}>
          <ThemeButton mode={theme} onClick={onTheme} />
          <NotificationBell />
        </div>
        <PageContent
          page={page}
          detailPodId={detailPodId}
          onOpenPod={openPodDetail}
          onClosePodDetail={closePodDetail}
        />
      </main>
    </div>
  );
}

function readInitialPage(): Page {
  try {
    return normalizePage(localStorage.getItem(PAGE_KEY)) ?? "pods";
  } catch (caught) {
    console.warn("page_preference_read_failed", caught);
    return "pods";
  }
}

function writePage(page: Page) {
  try {
    localStorage.setItem(PAGE_KEY, page);
  } catch (caught) {
    console.warn("page_preference_write_failed", caught);
  }
}

function normalizePage(value: string | null): Page | null {
  switch (value) {
    case "pods":
    case "users":
    case "skills":
    case "llm":
    case "settings":
    case "audit":
      return value;
    default:
      return null;
  }
}

function useResponsiveSidebar() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const collapseForCompactViewport = () => {
      if (window.innerWidth <= 768) setCollapsed(true);
    };
    window.addEventListener("resize", collapseForCompactViewport);
    return () => window.removeEventListener("resize", collapseForCompactViewport);
  }, []);
  return [collapsed, setCollapsed] as const;
}

function useCurrentUser() {
  const [user, setUser] = useState("...");
  useEffect(() => {
    let mounted = true;
    api
      .me()
      .then((result) => {
        if (mounted) setUser(result.actor);
      })
      .catch((caught: unknown) => {
        if (mounted) setUser(caught instanceof Error ? "加载失败" : "未知用户");
      });
    return () => {
      mounted = false;
    };
  }, []);
  return user;
}

interface SidebarProps {
  page: Page;
  user: string;
  collapsed: boolean;
  onPage: (page: Page) => void;
  onCollapsed: (collapsed: boolean) => void;
  onLogout: () => void;
}

function AppSidebar(props: SidebarProps) {
  return (
    <aside className={styles.sider} data-collapsed={props.collapsed}>
      <SidebarBrand collapsed={props.collapsed} onCollapsed={props.onCollapsed} />
      <nav className={styles.nav} aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={styles.navItem}
            type="button"
            data-active={props.page === item.key}
            aria-current={props.page === item.key ? "page" : undefined}
            aria-label={props.collapsed ? item.label : undefined}
            onClick={() => props.onPage(item.key)}
          >
            <span className={styles.navIcon}>{item.icon}</span>
            {!props.collapsed && <span className={styles.navText}>{item.label}</span>}
          </button>
        ))}
      </nav>
      <UserFooter user={props.user} collapsed={props.collapsed} onLogout={props.onLogout} />
    </aside>
  );
}

function SidebarBrand({
  collapsed,
  onCollapsed,
}: {
  collapsed: boolean;
  onCollapsed: (value: boolean) => void;
}) {
  return (
    <div className={styles.brand} data-collapsed={collapsed}>
      {!collapsed && (
        <div className={styles.brandText}>
          <span className={styles.brandMark}>muad</span>
          <span className={styles.brandTitle}>控制台</span>
        </div>
      )}
      <CollapseButton collapsed={collapsed} onChange={onCollapsed} />
    </div>
  );
}

function CollapseButton({
  collapsed,
  onChange,
}: {
  collapsed: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Button
      className={styles.collapse}
      aria-label={collapsed ? "展开导航" : "收起导航"}
      icon={collapsed ? <IconChevronRight /> : <IconChevronLeft />}
      theme="borderless"
      size="small"
      onClick={() => onChange(!collapsed)}
    />
  );
}

function UserFooter(props: { user: string; collapsed: boolean; onLogout: () => void }) {
  return (
    <div className={styles.user} data-collapsed={props.collapsed}>
      <span className={styles.avatar} aria-hidden="true">
        {props.user[0]?.toUpperCase()}
      </span>
      {!props.collapsed && <span className={styles.userName}>{props.user}</span>}
      <Button
        aria-label="退出登录"
        size="small"
        type="tertiary"
        theme="borderless"
        icon={<IconExit />}
        onClick={props.onLogout}
      />
    </div>
  );
}

function PageContent({
  page,
  detailPodId,
  onOpenPod,
  onClosePodDetail,
}: {
  page: Page;
  detailPodId: string | null;
  onOpenPod: (podId: string) => void;
  onClosePodDetail: () => void;
}) {
  if (detailPodId) {
    return <PodDetail podId={detailPodId} onBack={onClosePodDetail} onDeleted={onClosePodDetail} />;
  }
  if (page === "users") return <Users onOpenPod={onOpenPod} />;
  if (page === "skills") return <Skills />;
  if (page === "llm") return <LLM />;
  if (page === "settings") return <Settings />;
  if (page === "audit") return <Audit onOpenPod={onOpenPod} />;
  return <Containers />;
}
