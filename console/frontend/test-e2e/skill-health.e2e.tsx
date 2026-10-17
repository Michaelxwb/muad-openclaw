// TASK-012 S-05 UI boundary: render the real Audit page against a live Console
// (the Go E2E starts it and seeds the data). Only the request origin is
// rewritten so the app's relative `/api/v1` calls reach that Console; the API
// contract, auth header, response unwrapping and React rendering are all real.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it } from "vitest";
import { Audit } from "../src/pages/Audit";

const API_BASE = process.env.MUAD_E2E_API_BASE ?? "";
const SKILL = process.env.MUAD_E2E_SKILL ?? "";
const EXECUTION_ID = process.env.MUAD_E2E_EXECUTION_ID ?? "";

it("lists the flagged Skill from the real API and drills into its executions", async () => {
  if (!API_BASE || !SKILL || !EXECUTION_ID) {
    throw new Error("MUAD_E2E_API_BASE, MUAD_E2E_SKILL and MUAD_E2E_EXECUTION_ID are required");
  }
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(typeof input === "string" ? new URL(input, API_BASE) : input, init)) as typeof fetch;

  const login = await nativeFetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": "zh" },
    body: JSON.stringify({ username: "root", password: "pw" }),
  });
  const session = (await login.json()) as { data: { token: string } };
  localStorage.setItem("muad_token", session.data.token);

  window.history.replaceState(null, "", "/audit?tab=skill-health");
  render(<Audit />);

  const skillCell = await screen.findByText(SKILL);
  const row = skillCell.closest("tr");
  if (!row) throw new Error("health row not rendered as a table row");
  // Real SQL aggregates: 4 requests on the aborted run, one abort, one flagged.
  expect(within(row).getByText("4")).toBeInTheDocument();
  expect(within(row).getAllByText("1").length).toBeGreaterThanOrEqual(2);

  fireEvent.click(within(row).getByRole("button", { name: /查看执行日志/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `查看执行明细 ${EXECUTION_ID}` })).toBeInTheDocument(),
  );
});
