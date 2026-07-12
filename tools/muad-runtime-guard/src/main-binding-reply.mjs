export const MAIN_BINDING_REPLY =
  "当前账号尚未绑定。请联系管理员获取绑定码，然后发送 /bind <绑定码> 完成激活。";

export function createMainBindingReply({ mainAgentId }) {
  return (_event, context) => {
    if (context?.agentId !== mainAgentId) return undefined;
    return {
      handled: true,
      reply: { text: MAIN_BINDING_REPLY },
      reason: "muad-unbound-main",
    };
  };
}
