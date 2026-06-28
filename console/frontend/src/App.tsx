import { useState } from "react";
import { token } from "./api";
import { Sidebar } from "./components/Sidebar";
import { Audit } from "./pages/Audit";
import { Containers } from "./pages/Containers";
import { LLM } from "./pages/LLM";
import { Login } from "./pages/Login";
import styles from "./App.module.css";

type Page = "containers" | "llm" | "audit";

export function App() {
  const [authed, setAuthed] = useState(!!token.get());
  const [page, setPage] = useState<Page>("containers");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
      </main>
    </div>
  );
}
