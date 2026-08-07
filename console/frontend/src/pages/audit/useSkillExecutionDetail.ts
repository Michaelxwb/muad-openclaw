import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { SkillExecutionDetail } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { errorMessage } from "../../utils/error";

export function useSkillExecutionDetail(executionId: string | null) {
  const [detail, setDetail] = useState<SkillExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    if (!executionId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    setErrorDetail(undefined);
    try {
      const result = await api.getSkillExecution(executionId);
      if (mountedRef.current && requestId === requestRef.current) setDetail(result);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorMessage(caught, "execution.loadDetailFailed"));
      setErrorDetail(caught instanceof ApiError ? caught.detail : undefined);
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [executionId, mountedRef]);
  useEffect(() => {
    requestRef.current += 1;
    setDetail(null);
    setError("");
    setErrorDetail(undefined);
    setLoading(false);
    if (executionId) void refresh();
  }, [executionId, refresh]);
  return { detail, loading, error, errorDetail, refresh };
}
