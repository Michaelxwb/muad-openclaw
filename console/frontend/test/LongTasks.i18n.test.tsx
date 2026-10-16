import { readFileSync } from "node:fs";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LongTask, LongTaskListResult, LongTaskPool } from "../src/api";
import { LongTasks } from "../src/pages/LongTasks";
import i18n from "../src/i18n";
import en from "../src/i18n/locales/en";
import zh from "../src/i18n/locales/zh";

// LongTaskControlS27 [integration] 真实边界：真实 i18n 资源与语言切换、真实
// LongTasks 页面 + Semi 组件；api 仅作 HTTP 边界 mock。

const apiMocks = vi.hoisted(() => ({
  listLongTasks: vi.fn(),
  listAllHumanUsers: vi.fn(),
  listPods: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

function task(overrides: Partial<LongTask>): LongTask {
  return {
    taskId: "task-1",
    podId: "pod-a",
    humanUserId: "human-a",
    poolKey: "agent:alice:wecom:direct:wx-1",
    poolQueued: 0,
    poolRunning: 1,
    poolLimit: 2,
    agentId: "alice",
    peerId: "wx-1",
    skillName: "report-customer",
    skillRoot: "/skills/report",
    status: "running",
    stateRevision: 1,
    canCancel: true,
    submittedAt: "2026-10-15T08:00:00.000Z",
    updatedAt: "2026-10-15T08:00:00.000Z",
    lastSeenAt: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

const pool: LongTaskPool = {
  podId: "pod-a",
  humanUserId: "human-a",
  poolKey: "agent:alice:wecom:direct:wx-1",
  poolQueued: 0,
  poolRunning: 1,
  poolLimit: 2,
  agentId: "alice",
  peerId: "wx-1",
  updatedAt: "2026-10-15T08:00:00.000Z",
  lastSeenAt: "2026-10-15T08:00:00.000Z",
};

function listResult(tasks: LongTask[]): LongTaskListResult {
  return { items: tasks, pools: [pool], total: tasks.length, page: 1, pageSize: 20 };
}

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix.replace(/\.$/, "")];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, `${prefix}${key}.`),
  );
}

function subtree(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const REQUIRED_KEYS = [
  "status.cancelling",
  "status.cancelled",
  "longTasks.cancelQueued",
  "longTasks.terminate",
  "longTasks.terminateTitle",
  "longTasks.terminateContent",
  "longTasks.cancelRequested",
  "longTasks.cancelledNotice",
  "longTasks.cancelUnavailableUnknown",
  "longTasks.cancelUnavailableUnsupported",
  "longTasks.cancelUnavailableStatus",
  "longTasks.cancelFailed",
];

function hasKey(root: unknown, dotted: string): boolean {
  return subtree(root, dotted.split(".")) !== undefined;
}

beforeEach(() => {
  apiMocks.listLongTasks.mockReset();
  apiMocks.listAllHumanUsers.mockReset();
  apiMocks.listPods.mockReset();
  apiMocks.listAllHumanUsers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  apiMocks.listPods.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
});

afterEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("Long Task cancel i18n", () => {
  it("LongTaskControlS27 keeps zh/en cancel keys paired", () => {
    for (const key of REQUIRED_KEYS) {
      expect(hasKey(zh, key), `zh ${key}`).toBe(true);
      expect(hasKey(en, key), `en ${key}`).toBe(true);
    }
    for (const namespace of ["status", "longTasks"]) {
      const zhKeys = flattenKeys(subtree(zh, [namespace])).sort();
      const enKeys = flattenKeys(subtree(en, [namespace])).sort();
      expect(enKeys).toEqual(zhKeys);
    }
  });

  it("LongTaskControlS27 switches status column labels and buttons with the language", async () => {
    apiMocks.listLongTasks.mockResolvedValue(
      listResult([
        task({ taskId: "task-cancelling", status: "cancelling", cancelRequestedBy: "admin" }),
        task({
          taskId: "task-cancelled",
          status: "cancelled",
          cancelledAt: "2026-10-15T08:05:00.000Z",
        }),
      ]),
    );
    render(<LongTasks />);

    await waitFor(() => expect(screen.getAllByText("终止中").length).toBeGreaterThan(0));
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    await waitFor(() => expect(screen.getAllByText("Terminating").length).toBeGreaterThan(0));
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    await waitFor(() => expect(screen.getAllByText("终止中").length).toBeGreaterThan(0));
  });

  it("LongTaskControlS27 keeps the page free of a duplicated ConfigProvider", () => {
    const pageSource = readFileSync("src/pages/LongTasks.tsx", "utf8");
    expect(pageSource.includes("ConfigProvider")).toBe(false);
    const mainSource = readFileSync("src/main.tsx", "utf8");
    expect(mainSource.includes("ConfigProvider")).toBe(true);
  });
});
