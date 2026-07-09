import MarkdownIt from "markdown-it";
import YAML from "yaml";
import { z } from "zod";

import {
  WORKFLOW_AGENT_FINAL_INSTRUCTIONS_MAX_LENGTH,
  WORKFLOW_AGENT_GRACE_TIMEOUT_MAX_MS,
  WORKFLOW_AGENT_SOFT_TIMEOUT_MAX_MS,
  WORKFLOW_AGENT_TIMEOUT_MIN_MS,
} from "@/common/constants/workflows";
import { JsonValueSchema } from "@/common/orpc/schemas/workflow";
import { MAX_THINKING_INDEX, ThinkingLevelSchema } from "@/common/types/thinking";
import { getErrorMessage } from "@/common/utils/errors";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { formatZodIssues, normalizeNewlines, stripUtf8Bom } from "@/node/utils/markdownFrontmatter";

const SAFE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEMPLATE_REFERENCE_PATTERN = /\$?\{\{\s*([^{}]+?)\s*\}\}/gu;
const PROTECTED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const markdownParser = new MarkdownIt({ html: false, linkify: false, typographer: false });

const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const DeclarativeWorkflowInputSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "array"]).default("string"),
    description: z.string().trim().min(1).max(1_000).optional(),
    required: z.boolean().default(false),
    default: JsonValueSchema.optional(),
    enum: z.array(JsonScalarSchema).min(1).optional(),
  })
  .strict();

const DeclarativeWorkflowTimeoutSchema = z
  .object({
    soft_ms: z
      .number()
      .int()
      .min(WORKFLOW_AGENT_TIMEOUT_MIN_MS)
      .max(WORKFLOW_AGENT_SOFT_TIMEOUT_MAX_MS),
    grace_ms: z
      .number()
      .int()
      .min(WORKFLOW_AGENT_TIMEOUT_MIN_MS)
      .max(WORKFLOW_AGENT_GRACE_TIMEOUT_MAX_MS),
    final_instructions: z
      .string()
      .trim()
      .min(1)
      .max(WORKFLOW_AGENT_FINAL_INSTRUCTIONS_MAX_LENGTH)
      .optional(),
  })
  .strict();

const DeclarativeWorkflowStepSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(SAFE_NAME_PATTERN)
      .refine((id) => !PROTECTED_PATH_SEGMENTS.has(id), "Step id is reserved"),
    title: z.string().trim().min(1).max(200).optional(),
    agent: z.string().trim().min(1).max(128).default("exec"),
    model: z.string().trim().min(1).optional(),
    thinking: z
      .union([ThinkingLevelSchema, z.number().int().min(0).max(MAX_THINKING_INDEX)])
      .optional(),
    isolation: z.enum(["fork", "none"]).default("none"),
    on_refusal: z.enum(["fail", "fallback"]).optional(),
    schema: z.unknown().optional(),
    timeout: DeclarativeWorkflowTimeoutSchema.optional(),
  })
  .strict();

const DeclarativeWorkflowResultSchema = z
  .object({
    report_markdown: z.string().trim().min(1).max(200_000),
    structured_output: JsonValueSchema.optional(),
  })
  .strict();

const DeclarativeWorkflowFrontmatterSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(64).regex(SAFE_NAME_PATTERN),
    description: z.string().trim().min(1).max(1_024),
    inputs: z
      .record(
        z.string().trim().min(1).max(64).regex(SAFE_NAME_PATTERN),
        DeclarativeWorkflowInputSchema
      )
      .default({}),
    steps: z.array(DeclarativeWorkflowStepSchema).min(1).max(50),
    result: DeclarativeWorkflowResultSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow step id: ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      seen.add(step.id);
      if (step.agent === "plan" && step.schema !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Plan workflow steps cannot declare schema",
          path: ["steps", index, "schema"],
        });
      }
    });
  });

type DeclarativeWorkflowFrontmatter = z.infer<typeof DeclarativeWorkflowFrontmatterSchema>;
type DeclarativeWorkflowInput = z.infer<typeof DeclarativeWorkflowInputSchema>;

export interface ParsedDeclarativeWorkflow {
  frontmatter: DeclarativeWorkflowFrontmatter;
  instructions: string;
  stepPrompts: Readonly<Record<string, string>>;
}

export class DeclarativeWorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclarativeWorkflowParseError";
  }
}

export function isDeclarativeWorkflowSource(source: string): boolean {
  const firstLine = normalizeNewlines(stripUtf8Bom(source)).split("\n", 1)[0];
  return firstLine?.trim() === "---";
}

/** Parse and fully validate a Markdown workflow before any durable run is created. */
export function parseDeclarativeWorkflow(source: string): ParsedDeclarativeWorkflow {
  const byteSize = Buffer.byteLength(source, "utf8");
  if (byteSize > MAX_FILE_SIZE) {
    throw new DeclarativeWorkflowParseError(
      `Declarative workflow is too large (${(byteSize / (1024 * 1024)).toFixed(2)}MB). Maximum supported size is ${(MAX_FILE_SIZE / (1024 * 1024)).toFixed(2)}MB.`
    );
  }

  const content = normalizeNewlines(stripUtf8Bom(source));
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new DeclarativeWorkflowParseError(
      "Declarative workflow must start with YAML frontmatter delimited by '---'."
    );
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex === -1) {
    throw new DeclarativeWorkflowParseError(
      "Declarative workflow frontmatter is missing the closing '---' delimiter."
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(lines.slice(1, endIndex).join("\n"));
  } catch (error) {
    throw new DeclarativeWorkflowParseError(
      `Failed to parse declarative workflow YAML frontmatter: ${getErrorMessage(error)}`
    );
  }
  assertSafeWorkflowKeys(raw);

  const parsed = DeclarativeWorkflowFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeclarativeWorkflowParseError(
      `Invalid declarative workflow frontmatter: ${formatZodIssues(parsed.error.issues)}`
    );
  }

  validateRuntimeSchemas(parsed.data);
  const markdown = parseMarkdownStepPrompts(
    lines.slice(endIndex + 1).join("\n"),
    parsed.data.steps.map((step) => step.id)
  );
  validateTemplateReferences(parsed.data, markdown);
  return { frontmatter: parsed.data, ...markdown };
}

/** Compile the friendly template to the existing snapshotted durable JavaScript conductor. */
export function compileDeclarativeWorkflow(source: string): string {
  const parsed = parseDeclarativeWorkflow(source);
  const definition = {
    instructions: parsed.instructions,
    steps: parsed.frontmatter.steps.map((step) => ({
      ...step,
      prompt: parsed.stepPrompts[step.id],
    })),
    result: parsed.frontmatter.result,
  };
  const meta = {
    name: parsed.frontmatter.name,
    description: parsed.frontmatter.description,
    argsSchema: buildArgsSchema(parsed.frontmatter),
  };

  return `export const meta = ${JSON.stringify(meta, null, 2)};

const definition = JSON.parse(${JSON.stringify(JSON.stringify(definition))});

export default function workflow({ args, phase, agent }) {
  const steps = Object.create(null);
  for (const step of definition.steps) {
    phase(step.id, { title: step.title || step.id });
    const shared = definition.instructions ? renderString(definition.instructions, args, steps) : "";
    const prompt = renderString(step.prompt, args, steps);
    const options = {
      id: step.id,
      title: step.title || step.id,
      agentId: step.agent,
      isolation: step.isolation,
      ...(step.model ? { model: step.model } : {}),
      ...(step.thinking !== undefined ? { thinking: step.thinking } : {}),
      ...(step.on_refusal ? { onRefusal: step.on_refusal } : {}),
      ...(step.schema !== undefined ? { schema: step.schema } : {}),
      ...(step.timeout
        ? {
            timeout: {
              softMs: step.timeout.soft_ms,
              graceMs: step.timeout.grace_ms,
              ...(step.timeout.final_instructions
                ? { finalInstructions: step.timeout.final_instructions }
                : {}),
            },
          }
        : {}),
    };
    steps[step.id] = {
      output: agent(shared ? shared + "\\n\\n" + prompt : prompt, options),
    };
  }

  const reportValue = renderValue(definition.result.report_markdown, args, steps);
  const result = { reportMarkdown: formatTemplateValue(reportValue) };
  if (Object.prototype.hasOwnProperty.call(definition.result, "structured_output")) {
    result.structuredOutput = renderValue(definition.result.structured_output, args, steps);
  }
  return result;
}

function renderString(value, args, steps) {
  return formatTemplateValue(renderValue(value, args, steps));
}

function renderValue(value, args, steps) {
  if (typeof value === "string") {
    const exact = /^\\s*\\$?\\{\\{\\s*([^{}]+?)\\s*\\}\\}\\s*$/.exec(value);
    if (exact) return resolveReference(exact[1], args, steps);
    return value.replace(/\\$?\\{\\{\\s*([^{}]+?)\\s*\\}\\}/g, function (_match, reference) {
      return formatTemplateValue(resolveReference(reference, args, steps));
    });
  }
  if (Array.isArray(value)) {
    return value.map(function (item) { return renderValue(item, args, steps); });
  }
  if (value != null && typeof value === "object") {
    const rendered = Object.create(null);
    for (const key of Object.keys(value)) {
      rendered[key] = renderValue(value[key], args, steps);
    }
    return rendered;
  }
  return value;
}

function resolveReference(reference, args, steps) {
  const parts = String(reference).trim().split(".");
  let value;
  if (parts[0] === "args") {
    value = args;
  } else if (parts[0] === "steps") {
    value = steps;
  } else {
    throw new Error("Workflow template reference must start with args or steps: " + reference);
  }
  for (let index = 1; index < parts.length; index += 1) {
    const key = parts[index];
    if (
      value == null ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, key)
    ) {
      throw new Error("Workflow template reference is unavailable: " + reference);
    }
    value = value[key];
  }
  if (value === undefined) {
    throw new Error("Workflow template reference resolved to undefined: " + reference);
  }
  return value;
}

function formatTemplateValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) throw new Error("Workflow template value is undefined");
  return JSON.stringify(value, null, 2);
}
`;
}

function validateRuntimeSchemas(workflow: DeclarativeWorkflowFrontmatter): void {
  for (const [name, input] of Object.entries(workflow.inputs)) {
    if (input.default !== undefined) {
      assertValidInputValue(name, "default", buildInputPropertySchema(input), input.default);
    }
    input.enum?.forEach((value, index) =>
      assertValidInputValue(name, `enum[${index}]`, { type: input.type }, value)
    );
  }

  const argsValidation = validateJsonSchemaSubsetSchema(buildArgsSchema(workflow), {
    requireObjectSchema: true,
  });
  if (!argsValidation.success) {
    throw new DeclarativeWorkflowParseError(
      `Invalid declarative workflow inputs: ${formatJsonSchemaValidationErrors(argsValidation.errors)}`
    );
  }
  workflow.steps.forEach((step) => {
    if (step.schema === undefined) return;
    const validation = validateJsonSchemaSubsetSchema(step.schema, { requireObjectSchema: true });
    if (!validation.success) {
      throw new DeclarativeWorkflowParseError(
        `Invalid schema for workflow step ${step.id}: ${formatJsonSchemaValidationErrors(validation.errors)}`
      );
    }
  });
}

function assertValidInputValue(
  name: string,
  kind: string,
  schema: Record<string, unknown>,
  value: unknown
): void {
  const validation = validateJsonSchemaSubset(schema, value);
  if (!validation.success) {
    throw new DeclarativeWorkflowParseError(
      `Invalid ${kind} for workflow input ${name}: ${formatJsonSchemaValidationErrors(validation.errors)}`
    );
  }
}

function assertSafeWorkflowKeys(value: unknown, path = "$", active = new WeakSet<object>()): void {
  if (value == null || typeof value !== "object") return;
  if (active.has(value)) {
    throw new DeclarativeWorkflowParseError(
      `Declarative workflow data must not be cyclic at ${path}.`
    );
  }
  active.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (PROTECTED_PATH_SEGMENTS.has(key)) {
      throw new DeclarativeWorkflowParseError(
        `Unsafe declarative workflow key at ${path}.${key}: ${key}`
      );
    }
    assertSafeWorkflowKeys(child, `${path}.${key}`, active);
  }
  active.delete(value);
}

function parseMarkdownStepPrompts(
  body: string,
  stepIds: readonly string[]
): { instructions: string; stepPrompts: Readonly<Record<string, string>> } {
  const lines = body.split("\n");
  const headings = markdownParser.parse(body, {}).flatMap((token, index, tokens) => {
    if (token.type !== "heading_open" || token.tag !== "h2") return [];
    if (token.markup !== "##" || token.level !== 0) return [];
    const inline = tokens[index + 1];
    const id = inline?.type === "inline" ? inline.content.trim() : "";
    const start = token.map?.[0];
    const contentStart = token.map?.[1];
    return start == null || contentStart == null ? [] : [{ id, start, contentStart }];
  });
  const actualIds = headings.map((heading) => heading.id);
  if (actualIds.length !== stepIds.length || actualIds.some((id, index) => id !== stepIds[index])) {
    throw new DeclarativeWorkflowParseError(
      `Markdown step sections must appear once and in declared order. Expected: ${stepIds.map((id) => `## ${id}`).join(", ")}; found: ${actualIds.map((id) => `## ${id}`).join(", ") || "none"}.`
    );
  }

  const stepPrompts: Record<string, string> = {};
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? lines.length;
    const prompt = lines.slice(heading.contentStart, end).join("\n").trim();
    if (prompt.length === 0) {
      throw new DeclarativeWorkflowParseError(`Markdown section "## ${heading.id}" is empty.`);
    }
    stepPrompts[heading.id] = prompt;
  });
  return {
    instructions: lines
      .slice(0, headings[0]?.start ?? 0)
      .join("\n")
      .trim(),
    stepPrompts,
  };
}

function validateTemplateReferences(
  workflow: DeclarativeWorkflowFrontmatter,
  markdown: { instructions: string; stepPrompts: Readonly<Record<string, string>> }
): void {
  const inputNames = new Set(Object.keys(workflow.inputs));
  const availableSteps = new Set<string>();
  validateTemplateValue(markdown.instructions, "shared instructions", inputNames, availableSteps);
  for (const step of workflow.steps) {
    validateTemplateValue(
      markdown.stepPrompts[step.id],
      `step ${step.id}`,
      inputNames,
      availableSteps
    );
    availableSteps.add(step.id);
  }
  validateTemplateValue(
    workflow.result.report_markdown,
    "result.report_markdown",
    inputNames,
    availableSteps
  );
  if (workflow.result.structured_output !== undefined) {
    validateTemplateValue(
      workflow.result.structured_output,
      "result.structured_output",
      inputNames,
      availableSteps
    );
  }
}

function validateTemplateValue(
  value: unknown,
  location: string,
  inputNames: ReadonlySet<string>,
  availableSteps: ReadonlySet<string>
): void {
  if (typeof value === "string") {
    const matches = [...value.matchAll(TEMPLATE_REFERENCE_PATTERN)];
    const unmatched = value.replace(TEMPLATE_REFERENCE_PATTERN, "");
    if (unmatched.includes("{{") || unmatched.includes("}}")) {
      throw new DeclarativeWorkflowParseError(
        `Malformed workflow template expression in ${location}.`
      );
    }
    matches.forEach((match) =>
      validateReference(match[1] ?? "", location, inputNames, availableSteps)
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => validateTemplateValue(item, location, inputNames, availableSteps));
    return;
  }
  if (value != null && typeof value === "object") {
    Object.values(value).forEach((item) =>
      validateTemplateValue(item, location, inputNames, availableSteps)
    );
  }
}

function validateReference(
  rawReference: string,
  location: string,
  inputNames: ReadonlySet<string>,
  availableSteps: ReadonlySet<string>
): void {
  const reference = rawReference.trim();
  const parts = reference.split(".");
  if (parts.some((part) => part.length === 0 || PROTECTED_PATH_SEGMENTS.has(part))) {
    throw new DeclarativeWorkflowParseError(
      `Unsafe or malformed workflow template reference in ${location}: ${reference}`
    );
  }
  if (parts[0] === "args") {
    if (parts.length > 1 && !inputNames.has(parts[1] ?? "")) {
      throw new DeclarativeWorkflowParseError(
        `Unknown workflow input referenced in ${location}: ${reference}`
      );
    }
    return;
  }
  if (
    parts[0] !== "steps" ||
    parts.length < 3 ||
    parts[2] !== "output" ||
    !availableSteps.has(parts[1] ?? "")
  ) {
    throw new DeclarativeWorkflowParseError(
      `Unknown or forward workflow step reference in ${location}: ${reference}`
    );
  }
}

function buildArgsSchema(workflow: DeclarativeWorkflowFrontmatter): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, input] of Object.entries(workflow.inputs)) {
    properties[name] = buildInputPropertySchema(input);
    if (input.required) required.push(name);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function buildInputPropertySchema(input: DeclarativeWorkflowInput): Record<string, unknown> {
  return {
    type: input.type,
    ...(input.description != null ? { description: input.description } : {}),
    ...(input.default !== undefined ? { default: input.default } : {}),
    ...(input.enum != null ? { enum: input.enum } : {}),
  };
}
