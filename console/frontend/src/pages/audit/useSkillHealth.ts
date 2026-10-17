import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { SkillHealthItem, SkillHealthWindow } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";

export interface SkillHealthState {
  items: SkillHealthItem[];
  loading: boolean;
  error: string;
  errorDetail?: string;
  refresh: (background?: boolean) => Promise<void>;
}

export function useSkillHealth(active: boolean, window: SkillHealthWindow): SkillHealthState {
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const loadedRef = useRef(false);
  const [items, setItems] = useState<SkillHealthItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);

  const refresh = useCallback(
    async (background = false) => {
      if (!active) return;
      const requestId = ++requestRef.current;
      if (!background) setLoading(true);
      setError("");
      setErrorDetail(undefined);
      try {
        const response = await api.listSkillHealth({ window });
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setItems(Array.isArray(response.items) ? response.items : []);
      } catch (caught) {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        setError(errorMessage(caught, "audit.health.loadFailed"));
        setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
      } finally {
        loadedRef.current = true;
        if (!background && mountedRef.current && requestId === requestRef.current)
          setLoading(false);
      }
    },
    [active, mountedRef, window],
  );

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      return;
    }
    void refresh(loadedRef.current);
  }, [active, refresh]);

  return { items, loading, error, errorDetail, refresh };
}
