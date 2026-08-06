"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api } from "./api";
import type { BoardDocument, BoardSettings, StatusConfig } from "./boardTypes";
import type { StageMeta, StatusMeta } from "./types";
import { useAuth } from "./auth";

interface BoardSettingsState {
  settings: BoardSettings | null;
  document: BoardDocument | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Status catalog as StatusMeta for existing pickers. */
  statuses: StatusMeta[];
  /** Kanban columns as StageMeta for existing board consumers. */
  stages: StageMeta[];
  statusByKey: Map<string, StatusConfig>;
}

const BoardSettingsContext = createContext<BoardSettingsState>({
  settings: null,
  document: null,
  loading: true,
  error: null,
  refresh: async () => {},
  statuses: [],
  stages: [],
  statusByKey: new Map(),
});

export function BoardSettingsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setSettings(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.boardSettings();
      setSettings(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load board settings");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  const document = settings?.document ?? null;

  const statuses = useMemo<StatusMeta[]>(
    () =>
      (document?.statuses ?? []).map((s) => ({
        value: s.key as StatusMeta["value"],
        label: s.label,
        tone: s.tone,
      })),
    [document],
  );

  const stages = useMemo<StageMeta[]>(
    () =>
      (document?.kanbanColumns ?? []).map((c) => ({
        value: c.key as StageMeta["value"],
        label: c.label,
        tone: c.tone,
        statuses: c.statusKeys as StageMeta["statuses"],
      })),
    [document],
  );

  const statusByKey = useMemo(() => {
    const map = new Map<string, StatusConfig>();
    for (const s of document?.statuses ?? []) map.set(s.key, s);
    return map;
  }, [document]);

  const value = useMemo(
    () => ({
      settings,
      document,
      loading,
      error,
      refresh,
      statuses,
      stages,
      statusByKey,
    }),
    [settings, document, loading, error, refresh, statuses, stages, statusByKey],
  );

  return (
    <BoardSettingsContext.Provider value={value}>{children}</BoardSettingsContext.Provider>
  );
}

export const useBoardSettings = () => useContext(BoardSettingsContext);
