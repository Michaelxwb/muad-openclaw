import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { SkillExecutionDetail } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";

export function useSkillExecutionDetail(executionId: string | null) {
  const [detail, setDetail] = useState<SkillExecutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    if (!executionId) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.getSkillExecution(executionId);
      if (mountedRef.current && requestId === requestRef.current) setDetail(result);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : "加载 Skill 执行详情失败");
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, [executionId, mountedRef]);
  useEffect(() => {
    requestRef.current += 1;
    setDetail(null);
    setError("");
    setLoading(false);
    if (executionId) void refresh();
  }, [executionId, refresh]);
  return { detail, loading, error, refresh };
}
