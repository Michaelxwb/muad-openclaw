import { useEffect, useState } from "react";
import { api } from "../api";
import { NotificationBell } from "./NotificationBell";
import styles from "./Sidebar.module.css";

type Page = "containers" | "llm" | "audit";

interface Props {
  page: Page;
  onNavigate: (p: Page) => void;
  onLogout: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ page, onNavigate, onLogout, collapsed, onToggleCollapse }: Props) {
  const [user, setUser] = useState<string | null>(null);
  const [userErr, setUserErr] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((data) => setUser(data.actor))
      .catch(() => setUserErr(true));
  }, []);

  const navItems: { key: Page; label: string; icon: string }[] = [
    { key: "containers", label: "容器", icon: "📦" },
    { key: "llm", label: "模型配置", icon: "🧠" },
    { key: "audit", label: "审计日志", icon: "📋" },
  ];

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      <div className={styles.brand}>
        <span className={styles.brandText}>{collapsed ? "M" : "muad"}</span>
        <button
          className={styles.toggle}
          onClick={onToggleCollapse}
          title={collapsed ? "展开" : "收起"}
        >
          {collapsed ? "▶" : "◀"}
        </button>
      </div>

      <nav className={styles.menu}>
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`${styles.menuItem} ${page === item.key ? styles.active : ""}`}
            onClick={() => onNavigate(item.key)}
            title={collapsed ? item.label : undefined}
          >
            <span className={styles.icon}>{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className={styles.bottom}>
        <div className={styles.bell}>
          <NotificationBell />
        </div>
        {!collapsed && (
          <div className={styles.userSection}>
            <div className={styles.userRow}>
              <span className={styles.userIcon}>👤</span>
              <span className={styles.userName}>{userErr ? "未知用户" : (user ?? "加载中…")}</span>
            </div>
            <button className={styles.logoutBtn} onClick={onLogout}>
              退出
            </button>
          </div>
        )}
        {collapsed && (
          <button className={styles.logoutIcon} onClick={onLogout} title="退出">
            🚪
          </button>
        )}
      </div>
    </aside>
  );
}
