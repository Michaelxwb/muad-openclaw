import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Modal } from "@douyinfe/semi-ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Skills } from "../src/pages/Skills";

const apiMocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  scanSkills: vi.fn(),
  getPublicSkillStorage: vi.fn(),
  ensurePublicSkillStorage: vi.fn(),
  uploadPublicSkill: vi.fn(),
  updateSkill: vi.fn(),
  applySkills: vi.fn(),
}));

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

const skill = {
  skillId: "351e9298-76cb-4b35-a605-e1c406c85fac",
  name: "xdr-query",
  scope: "public" as const,
  displayName: "XDR Query",
  version: "1.0.0",
  status: "active" as const,
  sourcePath: "/Users/jahan/workspace/muad-openclaw/console/backend/data/skills/xdr-query",
  manifestHash: "sha256:01077db0e46820bf42065da6b9898417248f97bfe542",
  manifestJson: JSON.stringify({ name: "xdr-query", runtime: "script" }),
  entryType: "script",
  platformsJson: JSON.stringify(["xdr"]),
  browserRequired: true,
  progressSupported: true,
  systemProtected: false,
  createdAt: "2026-07-13T00:00:00Z",
  updatedAt: "2026-07-13T00:00:00Z",
};

beforeEach(() => {
  apiMocks.listSkills.mockReset().mockResolvedValue({
    items: [skill],
    total: 1,
    page: 1,
    pageSize: 10,
  });
  apiMocks.scanSkills.mockReset().mockResolvedValue({ scanned: 1, items: [skill] });
  apiMocks.getPublicSkillStorage.mockReset().mockResolvedValue({
    driver: "k8s",
    name: "muad-skills",
    namespace: "muad",
    configured: true,
    ready: true,
    phase: "Bound",
    accessMode: "ReadWriteMany",
    storageClass: "nfs-rwx",
    size: "5Gi",
    message: "Public Skill PVC 已就绪",
  });
  apiMocks.ensurePublicSkillStorage.mockReset().mockResolvedValue({
    driver: "k8s",
    name: "muad-skills",
    namespace: "muad",
    configured: true,
    ready: true,
    phase: "Bound",
    accessMode: "ReadWriteMany",
    storageClass: "nfs-rwx",
    size: "5Gi",
    message: "Public Skill PVC 已就绪",
  });
  apiMocks.uploadPublicSkill.mockReset().mockResolvedValue({
    skill,
    affectedPodIds: ["pod-a"],
  });
  apiMocks.updateSkill.mockReset().mockResolvedValue({
    skill: { ...skill, status: "disabled" },
    affectedPodIds: ["pod-a"],
  });
  apiMocks.applySkills.mockReset().mockResolvedValue({
    results: { "pod-a": "queued", "pod-b": "skipped_not_running" },
  });
});

describe("Skills", () => {
  it("lists Skill assets and opens the detail drawer", async () => {
    render(<Skills />);

    expect(await screen.findByText("XDR Query")).toBeInTheDocument();
    expect(screen.getByText(/需要点击「应用 Skill」/)).toBeInTheDocument();
    expect(screen.getByText("Public Skill 资产库")).toBeInTheDocument();
    expect(screen.queryByText(skill.sourcePath)).not.toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("xdr")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));

    expect(await screen.findByText(/Skill 详情 xdr-query/)).toBeInTheDocument();
    expect(screen.getByText(skill.skillId)).toBeInTheDocument();
    expect(screen.getByText(skill.manifestHash)).toBeInTheDocument();
    expect(screen.getByText(skill.sourcePath)).toBeInTheDocument();
  });

  it("searches and scans using the API client", async () => {
    render(<Skills />);
    await screen.findByText("XDR Query");

    fireEvent.change(screen.getByPlaceholderText("名称、ID 或路径"), {
      target: { value: "soar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询 Skill" }));
    await waitFor(() =>
      expect(apiMocks.listSkills).toHaveBeenLastCalledWith(expect.objectContaining({ q: "soar" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "扫描 Skill" }));
    await waitFor(() => expect(apiMocks.scanSkills).toHaveBeenCalledOnce());
  });

  it("updates a Skill status from row actions", async () => {
    render(<Skills />);
    await screen.findByText("XDR Query");

    fireEvent.click(screen.getByRole("button", { name: "禁用" }));
    expect(screen.getByText(/将 Skill/)).toBeInTheDocument();
    expect(screen.getByText(/该操作会更新控制面配置/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.updateSkill).toHaveBeenCalledWith(skill.skillId, { status: "disabled" }),
    );
  });

  it("applies Skill configuration to all Pods from the Skill toolbar", async () => {
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation((config) => {
      expect(config.title).toBe("应用 Skill 到所有 Pod");
      expect(config.content).toContain("所有运行中的 Pod");
      void config.onOk?.();
      return {} as ReturnType<typeof Modal.confirm>;
    });
    render(<Skills />);
    await screen.findByText("XDR Query");

    fireEvent.click(screen.getByRole("button", { name: "应用 Skill" }));

    await waitFor(() => expect(apiMocks.applySkills).toHaveBeenCalledOnce());
    confirm.mockRestore();
  });

  it("uploads a public Skill bundle from the Skill management toolbar", async () => {
    render(<Skills />);
    await screen.findByText("XDR Query");

    fireEvent.click(screen.getByRole("button", { name: "上传 Public Skill" }));
    const file = new File(["bundle"], "xdr-public.zip", { type: "application/zip" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input).toHaveAttribute("accept", ".tar.gz,.zip");
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(apiMocks.uploadPublicSkill).toHaveBeenCalledWith({
        bundle: file,
        filename: "xdr-public.zip",
      }),
    );
  });

  it("creates public Skill PVC before allowing public uploads", async () => {
    apiMocks.getPublicSkillStorage.mockResolvedValueOnce({
      driver: "k8s",
      name: "muad-skills",
      namespace: "muad",
      configured: true,
      ready: false,
      phase: "Missing",
      accessMode: "ReadWriteMany",
      storageClass: "nfs-rwx",
      size: "5Gi",
      message: "Public Skill PVC 尚未创建",
    });

    render(<Skills />);
    await screen.findByText("XDR Query");
    expect(screen.getByText(/Public Skill PVC 尚未创建/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传 Public Skill" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "创建 Public Skill PVC" }));
    await waitFor(() => expect(apiMocks.ensurePublicSkillStorage).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "上传 Public Skill" })).toBeEnabled(),
    );
  });
});
