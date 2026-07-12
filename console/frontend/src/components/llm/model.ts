import type { LLMForm, ModelOverrideInput } from "../../api";

export const EMPTY_MODEL: LLMForm = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "",
};

export function modelInput(value: LLMForm): ModelOverrideInput {
  const input: ModelOverrideInput = {
    provider: value.provider.trim(),
    baseUrl: value.baseUrl.trim(),
    model: value.model.trim(),
  };
  if (value.apiKey.trim()) input.apiKey = value.apiKey.trim();
  return input;
}
