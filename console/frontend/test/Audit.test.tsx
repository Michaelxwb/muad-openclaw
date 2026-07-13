import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/api";
import { Audit } from "../src/pages/Audit";

const auditMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, audit: auditMock } };
});

const entry: AuditEntry = {
  id: 1,
  actor: "admin:root",
  action: "identity.create",
  target: "identity-a",
  targetType: "identity",
  payload: '{"status":"active"}',
  metadata: {
    podId: "pod-a",
    humanUserId: "user-a",
    identityId: "identity-a",
    status: "active",
  },
  ts: "2026-07-11T00:00:00Z",
};

beforeEach(() => {
  auditMock.mockReset();
  auditMock.mockResolvedValue({ items: [entry], total: 1 });
});

describe("Audit", () => {
  it("shows semantic actor, target type, and scoped context", async () => {
    render(<Audit />);

    expect(await screen.findByText("admin:root")).toBeInTheDocument();
    expect(screen.getByText("identity.create")).toBeInTheDocument();
    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByText(/pod=pod-a/)).toBeInTheDocument();
    expect(screen.getByText(/user=user-a/)).toBeInTheDocument();
  });

  it("submits actor, action, and target filters through the typed API", async () => {
    render(<Audit />);
    await screen.findByText("admin:root");
    fireEvent.change(screen.getByLabelText("按操作人过滤"), { target: { value: "pod:pod-a" } });
    fireEvent.change(screen.getByLabelText("按动作过滤"), { target: { value: "runtime_guard" } });
    fireEvent.change(screen.getByLabelText("按目标过滤"), { target: { value: "pod-a" } });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() =>
      expect(auditMock).toHaveBeenLastCalledWith({
        actor: "pod:pod-a",
        action: "runtime_guard",
        target: "pod-a",
        offset: 0,
        limit: 10,
      }),
    );
  });
});
