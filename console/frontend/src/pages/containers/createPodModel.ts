import type { ChannelCredential, CreatePodInput } from "../../api";
import i18n from "../../i18n";

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
  maxLongTaskConcurrency: number;
  adoptState: boolean;
  restoreUsers: boolean;
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
  maxLongTaskConcurrency: 0,
  adoptState: false,
  restoreUsers: true,
};

export function validateCreateForm(form: CreateFormState): string {
  if (!form.podId.trim()) return i18n.t("pod.podIdRequired");
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(form.podId.trim())) {
    return i18n.t("pod.podIdInvalid");
  }
  if (form.displayName.trim().length > 128) return i18n.t("pod.displayNameTooLong");
  if (form.maxUsers < 1 || form.maxUsers > 10) return i18n.t("pod.maxUsersRange");
  if (/\s/.test(form.imageTag)) return i18n.t("pod.imageNoSpace");
  const memLimit = form.memLimit.trim();
  if (memLimit && !/^[0-9]+(?:\.[0-9]+)?([bkmg])?$/i.test(memLimit)) {
    return i18n.t("pod.memLimitInvalid");
  }
  const cpuLimit = form.cpuLimit.trim();
  if (cpuLimit && (!/^[0-9]+(?:\.[0-9]+)?$/.test(cpuLimit) || Number(cpuLimit) <= 0)) {
    return i18n.t("pod.cpuLimitInvalid");
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
    maxLongTaskConcurrency: form.maxLongTaskConcurrency,
    adoptState: form.adoptState,
    // 恢复原 Pod 用户依赖接管同名保留状态卷：不接管就没有记忆可恢复，
    // 因此 adoptState 未勾选时强制视为 false。
    restoreUsers: form.adoptState && form.restoreUsers,
  };
}
