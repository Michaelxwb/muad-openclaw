import type { ChannelCredential, CreatePodInput } from "../../api";

export interface CreateFormState {
  podId: string;
  displayName: string;
  imageTag: string;
  maxUsers: number;
  memLimit: string;
  cpuLimit: string;
  restartPolicy: string;
  maxSkillConcurrency: number;
  maxBrowserConcurrency: number;
}

export const EMPTY_CREATE_FORM: CreateFormState = {
  podId: "",
  displayName: "",
  imageTag: "",
  maxUsers: 10,
  memLimit: "",
  cpuLimit: "",
  restartPolicy: "",
  maxSkillConcurrency: 0,
  maxBrowserConcurrency: 0,
};

export function validateCreateForm(form: CreateFormState): string {
  if (!form.podId.trim()) return "Pod ID 必填";
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(form.podId.trim())) {
    return "Pod ID 仅支持小写字母、数字和中划线，长度不超过 63";
  }
  if (form.displayName.trim().length > 128) return "显示名称不能超过 128 个字符";
  if (form.maxUsers < 1 || form.maxUsers > 10) return "用户上限必须在 1 到 10 之间";
  if (/\s/.test(form.imageTag)) return "镜像地址不能包含空格";
  const memLimit = form.memLimit.trim();
  if (memLimit && !/^[0-9]+(?:\.[0-9]+)?[bkmg]$/i.test(memLimit)) {
    return "内存上限需要包含单位，例如 16g";
  }
  const cpuLimit = form.cpuLimit.trim();
  if (cpuLimit && (!/^[0-9]+(?:\.[0-9]+)?$/.test(cpuLimit) || Number(cpuLimit) <= 0)) {
    return "CPU 上限必须是大于 0 的数字";
  }
  return "";
}

export function createPodInput(
  form: CreateFormState,
  channels: string[],
  channelConfigs: Record<string, ChannelCredential>,
): CreatePodInput {
  return {
    podId: form.podId.trim(),
    displayName: form.displayName.trim() || form.podId.trim(),
    imageTag: form.imageTag.trim() || undefined,
    maxUsers: form.maxUsers,
    channels,
    channelConfigs,
    memLimit: form.memLimit.trim(),
    cpuLimit: form.cpuLimit.trim(),
    restartPolicy: form.restartPolicy,
    maxSkillConcurrency: form.maxSkillConcurrency,
    maxBrowserConcurrency: form.maxBrowserConcurrency,
  };
}
