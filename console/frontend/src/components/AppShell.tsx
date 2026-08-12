import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@douyinfe/semi-ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClockStroked,
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
import { LongTasks } from "../pages/LongTasks";
import { PodDetail } from "../pages/PodDetail";
import { Settings } from "../pages/Settings";
import { Skills } from "../pages/Skills";
import { Users } from "../pages/Users";
import { errorMessage } from "../utils/error";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NotificationBell } from "./NotificationBell";
import { ThemeButton } from "./ThemeButton";
import type { ThemeMode } from "./ThemeButton";
import styles from "./AppShell.module.css";

type Page = "pods" | "users" | "skills" | "longTasks" | "llm" | "settings" | "audit";

const PAGE_KEY = "muad_console_page";
const DETAIL_POD_KEY = "muad_console_pod_id";

interface Props {
  theme: ThemeMode;
  onTheme: () => void;
  onLogout: () => void;
}

export function AppShell({ theme, onTheme, onLogout }: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>(readInitialPage);
  const [detailPodId, setDetailPodId] = useState<string | null>(readInitialDetailPodId);
  const [collapsed, setCollapsed] = useResponsiveSidebar();
  const user = useCurrentUser();
  const navItems = useMemo(
    () => [
      { key: "pods" as Page, label: t("nav.pods"), icon: <IconServerStroked size="large" /> },
      { key: "users" as Page, label: t("nav.users"), icon: <IconUserGroup size="large" /> },
      { key: "skills" as Page, label: t("nav.skills"), icon: <IconPuzzle size="large" /> },
      {
        key: "longTasks" as Page,
        label: t("nav.longTasks"),
        icon: <IconClockStroked size="large" />,
      },
      { key: "llm" as Page, label: t("nav.llm"), icon: <IconComponentStroked size="large" /> },
      { key: "audit" as Page, label: t("nav.audit"), icon: <IconSearchStroked size="large" /> },
      {
        key: "settings" as Page,
        label: t("nav.settings"),
        icon: <IconSettingStroked size="large" />,
      },
    ],
    [t],
  );
  const changePage = (next: Page) => {
    setDetailPodId(null);
    writeDetailPodId(null);
    setPage(next);
    writePage(next);
  };
  const openPodDetail = (podId: string) => {
    setDetailPodId(podId);
    writeDetailPodId(podId);
    setPage("pods");
    writePage("pods");
  };
  const closePodDetail = () => {
    setDetailPodId(null);
    writeDetailPodId(null);
  };
  return (
    <div className={styles.layout}>
      <AppSidebar
        page={page}
        user={user}
        collapsed={collapsed}
        navItems={navItems}
        onPage={changePage}
        onCollapsed={setCollapsed}
        onLogout={onLogout}
      />
      <main className={styles.content}>
        <div className={styles.topbar}>
          <ThemeButton mode={theme} onClick={onTheme} />
          <LanguageSwitcher />
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

function readInitialDetailPodId(): string | null {
  try {
    const value = localStorage.getItem(DETAIL_POD_KEY)?.trim();
    return value ? value : null;
  } catch (caught) {
    console.warn("pod_detail_preference_read_failed", caught);
    return null;
  }
}

function writeDetailPodId(podId: string | null) {
  try {
    if (podId) localStorage.setItem(DETAIL_POD_KEY, podId);
    else localStorage.removeItem(DETAIL_POD_KEY);
  } catch (caught) {
    console.warn("pod_detail_preference_write_failed", caught);
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
    case "longTasks":
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
        if (mounted) setUser(errorMessage(caught, "nav.loadFailed"));
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
  navItems: { key: Page; label: string; icon: ReactNode }[];
  onPage: (page: Page) => void;
  onCollapsed: (collapsed: boolean) => void;
  onLogout: () => void;
}

function AppSidebar(props: SidebarProps) {
  const { t } = useTranslation();
  return (
    <aside className={styles.sider} data-collapsed={props.collapsed}>
      <SidebarBrand collapsed={props.collapsed} onCollapsed={props.onCollapsed} />
      <nav className={styles.nav} aria-label={t("nav.mainNav")}>
        {props.navItems.map((item) => (
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
  const { t } = useTranslation();
  return (
    <div className={styles.brand} data-collapsed={collapsed}>
      {!collapsed && (
        <div className={styles.brandText}>
          <span className={styles.brandMark}>muad</span>
          <span className={styles.brandTitle}>{t("nav.console")}</span>
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
  const { t } = useTranslation();
  return (
    <Button
      className={styles.collapse}
      aria-label={collapsed ? t("nav.expandNav") : t("nav.collapseNav")}
      icon={collapsed ? <IconChevronRight /> : <IconChevronLeft />}
      theme="borderless"
      size="small"
      onClick={() => onChange(!collapsed)}
    />
  );
}

function UserFooter(props: { user: string; collapsed: boolean; onLogout: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.user} data-collapsed={props.collapsed}>
      <span className={styles.avatar} aria-hidden="true">
        {props.user[0]?.toUpperCase()}
      </span>
      {!props.collapsed && <span className={styles.userName}>{props.user}</span>}
      <Button
        aria-label={t("nav.logout")}
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
  if (page === "longTasks") return <LongTasks onOpenPod={onOpenPod} />;
  if (page === "llm") return <LLM />;
  if (page === "settings") return <Settings />;
  if (page === "audit") return <Audit onOpenPod={onOpenPod} />;
  return <Containers onOpenPod={onOpenPod} />;
}
