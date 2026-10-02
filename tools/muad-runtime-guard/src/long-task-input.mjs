const REQUEST_KEYS = ["skillName", "objective", "selectionBasis", "requiredNames", "bindings"];
const BINDING_KEYS = ["name", "value", "source"];
const SELECTIONS = new Set(["unique_match", "user_choice", "explicit_name"]);
const SOURCES = new Set(["user_message", "conversation", "document_default", "document_resolution"]);
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function validateLongTaskInput(value) {
  if (!exactObject(value, REQUEST_KEYS) ||
      typeof value.skillName !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.skillName) ||
      !text(value.objective) || !SELECTIONS.has(value.selectionBasis) ||
      !Array.isArray(value.requiredNames) || !Array.from(value.requiredNames).every(parameterName) ||
      !Array.isArray(value.bindings) || !Array.from(value.bindings).every(validBinding)) {
    return rejected("invalid_input");
  }
  const requiredNames = [...new Set(value.requiredNames.map((name) => name.trim()))];
  const bindings = value.bindings.map((binding) => ({
    name: binding.name.trim(), value: binding.value.trim(), source: binding.source,
  }));
  const names = new Set(bindings.map((binding) => binding.name));
  if (names.size !== bindings.length) return rejected("invalid_input");
  const present = new Set(bindings.filter((binding) => binding.value).map((binding) => binding.name));
  const missingNames = [...new Set([
    ...requiredNames.filter((name) => !present.has(name)),
    ...bindings.filter((binding) => !binding.value).map((binding) => binding.name),
  ])];
  if (missingNames.length) return { ...rejected("missing_input"), missingNames };
  return {
    ok: true,
    input: {
      skillName: value.skillName, objective: value.objective.trim(),
      selectionBasis: value.selectionBasis, requiredNames, bindings,
    },
  };
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validBinding(binding) {
  return exactObject(binding, BINDING_KEYS) && parameterName(binding.name) &&
    typeof binding.value === "string" && SOURCES.has(binding.source);
}

function parameterName(value) {
  return text(value) && !UNSAFE_NAMES.has(value.trim());
}

function text(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function rejected(reason) {
  return { ok: false, reason };
}
