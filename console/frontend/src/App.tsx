import { useEffect, useState } from "react";
import { token, UNAUTHORIZED_EVENT } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Audit } from "./pages/Audit";
import { Containers } from "./pages/Containers";
import { LLM } from "./pages/LLM";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import styles from "./App.module.css";

type Page = "containers" | "llm" | "audit" | "settings";

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [page, setPage] = useState<Page>("containers");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // A 401 from any request (e.g. expired token) drops back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  function logout() {
    token.clear();
    setAuthed(false);
  }

  return (
    <div className={styles.layout}>
      <Sidebar
        page={page}
        onNavigate={setPage}
        onLogout={logout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className={`${styles.main} ${sidebarCollapsed ? styles.mainCollapsed : ""}`}>
        {page === "containers" && <Containers />}
        {page === "llm" && <LLM />}
        {page === "audit" && <Audit />}
        {page === "settings" && <Settings />}
      </main>
    </div>
  );
}
