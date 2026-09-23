"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type UiTheme = "meow" | "scc";

const KEY = "l12-ui-theme";

type ThemeState = {
  theme: UiTheme;
  setTheme: (next: UiTheme) => void;
  productName: string;
};

const ThemeContext = createContext<ThemeState>({
  theme: "meow",
  setTheme: () => {},
  productName: "L12",
});

function readStored(): UiTheme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "scc" || attr === "meow") return attr;
  }
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "scc" || raw === "meow") return raw;
  } catch {
    /* ignore */
  }
  return "meow";
}

function applyTheme(next: UiTheme) {
  document.documentElement.setAttribute("data-theme", next);
  document.documentElement.style.colorScheme = next === "scc" ? "light" : "dark";
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<UiTheme>("meow");

  useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
    applyTheme(stored);
  }, []);

  useEffect(() => {
    document.title = theme === "scc" ? "SCC - Guarder" : "L12 App";
  }, [theme]);

  const setTheme = useCallback((next: UiTheme) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      setTheme,
      productName: theme === "scc" ? "SCC - Guarder" : "L12",
    }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useUiTheme() {
  return useContext(ThemeContext);
}
