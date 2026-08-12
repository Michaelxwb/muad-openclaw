import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Pod } from "../api";
import { useMountedRef } from "./useMountedRef";

/**
 * 拉取全部 Pod 的 podId → displayName 映射，供列表表格展示 Pod 名称。
 * 映射缺失（拉取失败或 Pod 已删除）时调用方回退展示 podId。
 */
export function usePodNames(active: boolean): ReadonlyMap<string, string> {
  const mountedRef = useMountedRef();
  const requestRef = useRef(0);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      return;
    }
    const requestId = ++requestRef.current;
    void listAllPods()
      .then((pods) => {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        const map = new Map<string, string>();
        for (const pod of pods) {
          if (pod.displayName) map.set(pod.podId, pod.displayName);
        }
        setNames(map);
      })
      .catch(() => {
        // 名称映射失败不阻塞列表；表格回退显示 podId
      });
  }, [active, mountedRef]);

  return names;
}

async function listAllPods(): Promise<Pod[]> {
  const pageSize = 100;
  const first = await api.listPods({ page: 1, pageSize });
  const items = [...first.items];
  for (let page = 2; items.length < first.total; page++) {
    const result = await api.listPods({ page, pageSize });
    items.push(...result.items);
    if (result.items.length === 0) break;
  }
  return items;
}
