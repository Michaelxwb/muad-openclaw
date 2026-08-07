import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { Pod, PodResourceConfig } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";

export function usePodData(podId: string) {
  const [pod, setPod] = useState<Pod | null>(null);
  const [resources, setResources] = useState<PodResourceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (mountedRef.current) {
      setError("");
      setErrorDetail(undefined);
    }
    try {
      const [podResult, resourceResult] = await Promise.all([
        api.getPod(podId),
        api.getPodResources(podId),
      ]);
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setPod(podResult);
      setResources(resourceResult);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "pod.detailLoadFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [mountedRef, podId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { pod, resources, loading, error, errorDetail, refresh };
}
