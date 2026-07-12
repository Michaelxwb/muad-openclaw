import { BindingClientError } from "./binding-client.mjs";
import { activationFromCommand, BindingContextError } from "./binding-context.mjs";

export function createBindCommand({ client, mainAgentId, onRejected }) {
  return {
    name: "bind",
    description: "Activate an administrator-issued Muad identity binding code.",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (context) => {
      try {
        const request = activationFromCommand(context, mainAgentId);
        await client.activate(request);
        return consumed("绑定成功，配置正在应用，请稍后重新发送业务消息。");
      } catch (error) {
        if (error instanceof BindingContextError) {
          onRejected?.({ code: error.code, reason: error.reason });
        }
        return consumed(bindingFailureText(error));
      }
    },
  };
}

function bindingFailureText(error) {
  if (error instanceof BindingContextError) {
    if (error.code === "direct_context_required") return "绑定仅支持在指定机器人的私聊中进行。";
    if (error.code === "unsupported_channel") return "当前消息通道暂不支持绑定。";
    return "绑定码格式不正确，请检查后重试。";
  }
  if (error instanceof BindingClientError) {
    if (error.code === "rate_limited") return "绑定尝试过于频繁，请稍后重试。";
    if (error.code === "invalid_binding") return "绑定码无效、已过期或与当前机器人不匹配。";
  }
  return "绑定服务暂时不可用，请稍后重试。";
}

function consumed(text) {
  return { text, continueAgent: false };
}
