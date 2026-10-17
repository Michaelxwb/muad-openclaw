import { describe, expect, it } from "vitest";
import {
  EMPTY_CREATE_FORM,
  MAX_USERS_PER_POD,
  validateCreateForm,
  type CreateFormState,
} from "../src/pages/containers/createPodModel";

function form(overrides: Partial<CreateFormState> = {}): CreateFormState {
  return { ...EMPTY_CREATE_FORM, podId: "pod-a", maxUsers: 10, ...overrides };
}

describe("createPodModel maxUsers 边界", () => {
  it("accepts the admin capacity up to the shared limit", () => {
    expect(validateCreateForm(form({ maxUsers: MAX_USERS_PER_POD }))).toBe("");
  });

  it("rejects values above the limit with the localized range message", () => {
    expect(validateCreateForm(form({ maxUsers: MAX_USERS_PER_POD + 1 }))).toBe(
      "用户上限必须在 1 到 100 之间",
    );
  });

  it("rejects zero and negative values", () => {
    expect(validateCreateForm(form({ maxUsers: 0 }))).toContain("用户上限");
    expect(validateCreateForm(form({ maxUsers: -1 }))).toContain("用户上限");
  });
});
