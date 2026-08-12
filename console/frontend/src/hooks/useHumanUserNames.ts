import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMountedRef } from "./useMountedRef";

/**
 * 拉取全部 Human User 的 humanUserId → displayName 映射，供列表表格展示用户名称。
 * 映射缺失（拉取失败或用户已删除）时调用方回退展示 humanUserId。
 */
export function useHumanUserNames(active: boolean): ReadonlyMap<string, string> {
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      return;
    }
    const requestId = ++requestRef.current;
    void api
      .listAllHumanUsers({ pageSize: 1000 })
      .then((result) => {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        const map = new Map<string, string>();
        for (const user of result.items) {
          if (user.displayName) map.set(user.humanUserId, user.displayName);
        }
        setNames(map);
      })
      .catch(() => {
        // 名称映射失败不阻塞列表；表格回退显示 humanUserId
      });
  }, [active, mountedRef]);

  return names;
}
