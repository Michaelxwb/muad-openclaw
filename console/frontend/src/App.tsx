import { useEffect, useState } from "react";
import { token, UNAUTHORIZED_EVENT } from "./api";
import { AppShell } from "./components/AppShell";
import { ThemeButton } from "./components/ThemeButton";
import type { ThemeMode } from "./components/ThemeButton";
import { Login } from "./pages/Login";

const THEME_KEY = "muad_theme";

export function App() {
  const [authed, setAuthed] = useState(Boolean(token.get()));
  const theme = useTheme();
  useEffect(() => {
    const unauthorized = () => setAuthed(false);
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
  }, []);
  if (authed) {
    return (
      <AppShell
        theme={theme.mode}
        onTheme={theme.toggle}
        onLogout={() => {
          token.clear();
          setAuthed(false);
        }}
      />
    );
  }
  return (
    <>
      <Login onLogin={() => setAuthed(true)} />
      <div style={{ position: "fixed", top: 16, right: 16, zIndex: 999 }}>
        <ThemeButton mode={theme.mode} onClick={theme.toggle} />
      </div>
    </>
  );
}

function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readTheme);
  useEffect(() => {
    document.body.setAttribute("theme-mode", mode);
  }, [mode]);
  const toggle = () => {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (caught) {
      console.warn("theme_preference_write_failed", caught);
    }
  };
  return { mode, toggle };
}

function readTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "dark";
  } catch (caught) {
    console.warn("theme_preference_read_failed", caught);
    return "dark";
  }
}
