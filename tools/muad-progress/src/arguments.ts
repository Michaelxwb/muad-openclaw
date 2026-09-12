import { ProgressError } from "./errors.js";
import type { ProgressEventType } from "./protocol.js";

export type EventCommand = "stage" | "done" | "error" | "validate";

export type ParsedArguments = {
  command: EventCommand;
  type: ProgressEventType;
  stage: string;
  text: string;
  jsonOutput: boolean;
  rawOutput: boolean;
  media: string[];
  skill?: string;
  id?: string;
  code?: string;
};

const EVENT_COMMANDS = new Set<EventCommand>(["stage", "done", "error", "validate"]);
const VALUE_FLAGS = new Set(["stage", "text", "skill", "id", "code", "media"]);

export function parseArguments(args: readonly string[]): ParsedArguments {
  const command = readCommand(args[0]);
  const { values, jsonOutput, rawOutput, media } = parseFlags(args.slice(1));
  rejectDisallowedFlags(command, values, rawOutput, media);
  const stage = requiredValue(values, "stage");
  const text = requiredValue(values, "text");
  const type = command === "stage" || command === "validate" ? "progress" : command;
  return {
    command, type, stage, text, jsonOutput, rawOutput, media,
    ...copyOptional(values, "skill"),
    ...copyOptional(values, "id"),
    ...copyOptional(values, "code"),
  };
}

function parseFlags(args: readonly string[]): {
  values: Map<string, string>;
  jsonOutput: boolean;
  rawOutput: boolean;
  media: string[];
} {
  const values = new Map<string, string>();
  let jsonOutput = false;
  let rawOutput = false;
  const media: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--json") {
      if (jsonOutput) invalidArguments();
      jsonOutput = true;
      continue;
    }
    if (raw === "--raw") {
      if (rawOutput) invalidArguments();
      rawOutput = true;
      continue;
    }
    const name = parseValueFlag(raw);
    const value = args[index + 1];
    if (value === undefined || value === "--json" || value === "--raw") invalidArguments();
    if (name === "media") media.push(value);
    else {
      if (values.has(name)) invalidArguments();
      values.set(name, value);
    }
    index += 1;
  }
  return { values, jsonOutput, rawOutput, media };
}

function readCommand(value: string | undefined): EventCommand {
  if (value === undefined || !EVENT_COMMANDS.has(value as EventCommand)) invalidArguments();
  return value as EventCommand;
}

function parseValueFlag(value: string | undefined): string {
  if (value === undefined || !value.startsWith("--")) invalidArguments();
  const name = value.slice(2);
  if (!VALUE_FLAGS.has(name)) invalidArguments();
  return name;
}

function rejectDisallowedFlags(
  command: EventCommand,
  values: ReadonlyMap<string, string>,
  rawOutput: boolean,
  media: readonly string[],
): void {
  if (values.has("code") && command !== "error") invalidArguments();
  if ((rawOutput || media.length > 0) && command !== "done") invalidArguments();
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") invalidArguments();
  return value.trim();
}

function copyOptional(values: ReadonlyMap<string, string>, name: "skill" | "id" | "code"): object {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") return {};
  return { [name]: value.trim() };
}

function invalidArguments(): never {
  throw new ProgressError("invalid_arguments");
}
