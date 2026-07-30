import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ChannelForm } from "../src/components/ChannelForm";

// Semi Checkbox nests the label inside a span with aria-labelledby wiring,
// not a real <label for=>. Click the addon span to toggle.
const wecomCheckbox = () => screen.getByText("🏢 企业微信");
const wechatCheckbox = () => screen.getByText("💬 微信");
const mattermostCheckbox = () => screen.getByText("M Mattermost");

describe("ChannelForm", () => {
  it("renders one checkbox per registered channel", () => {
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(wechatCheckbox()).toBeInTheDocument();
    expect(wecomCheckbox()).toBeInTheDocument();
    expect(mattermostCheckbox()).toBeInTheDocument();
  });

  it("blocks submit when no channel is selected", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={onSubmit} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/至少选择一个通道/)).toBeInTheDocument();
  });

  it("blocks submit when a credentialed channel is selected without required creds", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={onSubmit} onCancel={() => {}} />,
    );
    fireEvent.click(wecomCheckbox());
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/必填/)).toBeInTheDocument();
  });

  it("shows hint for credential-less channels (WeChat) when selected", () => {
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(wechatCheckbox());
    expect(screen.getByText(/扫码/)).toBeInTheDocument(); // hint mentions 扫码
  });

  it("submits valid payload when all required creds are filled", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={onSubmit} onCancel={() => {}} />,
    );
    fireEvent.click(wecomCheckbox());
    // Fill the two required fields. botId is a text input; secret is password.
    const inputs = document.querySelectorAll(
      'input[type="text"], input:not([type])',
    ) as NodeListOf<HTMLInputElement>;
    // Find botId input by placeholder/value hint — first visible text input under
    // the WeCom panel.
    let botInput: HTMLInputElement | null = null;
    document.querySelectorAll("input").forEach((el) => {
      if (el.type !== "password" && el.type !== "checkbox" && !botInput)
        botInput = el as HTMLInputElement;
    });
    expect(botInput).not.toBeNull();
    fireEvent.change(botInput!, { target: { value: "wb-123" } });
    const secretInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(secretInput).not.toBeNull();
    fireEvent.change(secretInput!, { target: { value: "topsecret" } });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.channels).toEqual(["wecom"]);
    expect(payload.channelConfigs.wecom.botId).toBe("wb-123");
    expect(payload.channelConfigs.wecom.secret).toBe("topsecret");
    // suppress unused-var lint on inputs
    void inputs;
  });

  it("submits Mattermost URL, token, and private network flag", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm mode="create" busy={false} error="" onSubmit={onSubmit} onCancel={() => {}} />,
    );
    fireEvent.click(mattermostCheckbox());
    fireEvent.change(screen.getByPlaceholderText("https://mattermost.example.com"), {
      target: { value: "https://mattermost.internal" },
    });
    fireEvent.change(screen.getByPlaceholderText("创建令牌时显示的完整 token"), {
      target: { value: "mm-token" },
    });
    fireEvent.click(screen.getByText("允许访问内网地址"));

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.channels).toEqual(["mattermost"]);
    expect(payload.channelConfigs.mattermost).toEqual({
      baseUrl: "https://mattermost.internal",
      botToken: "mm-token",
      allowPrivateNetwork: "true",
    });
  });

  it("skips required validation in edit mode when secret is already configured", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm
        mode="edit"
        initial={{
          channels: ["wecom"],
          channelConfigs: {
            wecom: { botId: "wb-existing", secretConfigured: true },
          },
        }}
        busy={false}
        error=""
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // WeCom is already ticked; botId pre-filled; secret left empty (keep current).
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.channels).toEqual(["wecom"]);
    expect(payload.channelConfigs.wecom.botId).toBe("wb-existing");
    // secret kept empty → backend will reuse the stored value.
    expect(payload.channelConfigs.wecom.secret ?? "").toBe("");
  });

  it("keeps existing Mattermost token in edit mode while preserving visible fields", () => {
    const onSubmit = vi.fn();
    render(
      <ChannelForm
        mode="edit"
        initial={{
          channels: ["mattermost"],
          channelConfigs: {
            mattermost: {
              baseUrl: "https://mattermost.internal",
              allowPrivateNetwork: "true",
              secretConfigured: true,
            },
          },
        }}
        busy={false}
        error=""
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.channelConfigs.mattermost.baseUrl).toBe("https://mattermost.internal");
    expect(payload.channelConfigs.mattermost.allowPrivateNetwork).toBe("true");
    expect(payload.channelConfigs.mattermost.botToken ?? "").toBe("");
  });
});
