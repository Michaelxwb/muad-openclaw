import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { HumanUser } from "../api";
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
    void listAllHumanUsers()
      .then((users) => {
        if (!mountedRef.current || requestId !== requestRef.current) return;
        const map = new Map<string, string>();
        for (const user of users) {
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

// 后端单页上限 100（parsePodPagination 的 maxPodPageSize），用户总数可超一页；
// 逐页取全量，避免超出首页的用户因映射缺失回退成 id。
async function listAllHumanUsers(): Promise<HumanUser[]> {
  const pageSize = 100;
  const first = await api.listAllHumanUsers({ page: 1, pageSize });
  const items = [...first.items];
  for (let page = 2; items.length < first.total; page++) {
    const result = await api.listAllHumanUsers({ page, pageSize });
    items.push(...result.items);
    if (result.items.length === 0) break;
  }
  return items;
}
