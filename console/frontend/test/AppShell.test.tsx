import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell";

const apiMocks = vi.hoisted(() => ({ me: vi.fn(), alerts: vi.fn() }));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});
vi.mock("../src/pages/Containers", () => ({ Containers: () => <div>Pods Page</div> }));
vi.mock("../src/pages/LLM", () => ({ LLM: () => <div>LLM Page</div> }));
vi.mock("../src/pages/Settings", () => ({ Settings: () => <div>Settings Page</div> }));
vi.mock("../src/pages/Audit", () => ({ Audit: () => <div>Audit Page</div> }));

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  apiMocks.me.mockReset().mockResolvedValue({ actor: "admin" });
  apiMocks.alerts.mockReset().mockResolvedValue([]);
});

describe("AppShell", () => {
  it("uses Pod navigation semantics and switches retained application pages", async () => {
    render(<AppShell theme="dark" onTheme={vi.fn()} onLogout={vi.fn()} />);

    expect(screen.getByText("Pod 管理")).toBeInTheDocument();
    expect(screen.getByText("Pods Page")).toBeInTheDocument();
    fireEvent.click(screen.getByText("模型配置"));
    expect(screen.getByText("LLM Page")).toBeInTheDocument();
    fireEvent.click(screen.getByText("资源与平台"));
    expect(screen.getByText("Settings Page")).toBeInTheDocument();
    fireEvent.click(screen.getByText("审计日志"));
    expect(screen.getByText("Audit Page")).toBeInTheDocument();
  });

  it("collapses the navigation when the viewport becomes compact", () => {
    render(<AppShell theme="dark" onTheme={vi.fn()} onLogout={vi.fn()} />);

    expect(screen.getByRole("button", { name: "收起导航" })).toBeInTheDocument();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    fireEvent(window, new Event("resize"));

    expect(screen.getByRole("button", { name: "展开导航" })).toBeInTheDocument();
  });

  it("keeps the sidebar brand explicit on desktop and compact when collapsed", () => {
    render(<AppShell theme="dark" onTheme={vi.fn()} onLogout={vi.fn()} />);

    expect(screen.getByText("muad")).toBeInTheDocument();
    expect(screen.getByText("控制台")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));

    expect(screen.queryByText("muad")).not.toBeInTheDocument();
    expect(screen.queryByText("控制台")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });
});
