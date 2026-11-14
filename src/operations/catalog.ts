import * as z from "zod/v4";
import { type Access, type Category, OPERATION_GROUPS, type Operation } from "./define";
import { OPERATIONS } from "./index";

/** One argument of an operation, in the terms both surfaces present it. */
export interface Argument {
  /** The key in MCP `arguments`. On the CLI it is the flag `--name-with-dashes`. */
  name: string;
  type: "string" | "integer" | "boolean" | "map";
  required: boolean;
  description?: string;
  choices?: string[];
  default?: unknown;
}

export interface OperationInfo {
  name: string;
  category: Category;
  summary: string;
  description?: string;
  access: Access;
  returns: "json" | "file";
  arguments: Argument[];
}

interface JsonProperty {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

function argumentType(property: JsonProperty): Argument["type"] {
  if (property.type === "integer" || property.type === "number") return "integer";
  if (property.type === "boolean") return "boolean";
  if (property.type === "object") return "map";
  return "string";
}

/** The arguments of an operation, read from its schema so help can never disagree with validation. */
export function argumentsOf(label: Operation): Argument[] {
  const schema = z.toJSONSchema(label.input, { io: "input" }) as {
    properties?: Record<string, JsonProperty>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([label_, property]) => ({
    name: label_,
    type: argumentType(property),
    required: required.has(label_),
    ...(property.description ? { description: property.description } : {}),
    ...(property.enum ? { choices: property.enum } : {}),
    ...(property.default === undefined ? {} : { default: property.default }),
  }));
}

export function describe(label: Operation): OperationInfo {
  return {
    name: label.name,
    category: label.category,
    summary: label.summary,
    ...(label.description ? { description: label.description } : {}),
    access: label.access,
    returns: label.returns,
    arguments: argumentsOf(label),
  };
}

/** `lab-values request_id doc_id` or `test-results [year] [limit] [offset]`: the name and its arguments on one line. */
export function signature(label: Operation): string {
  const segments = argumentsOf(label).map((argument) => (argument.required ? argument.name : `[${argument.name}]`));
  return [label.name, ...segments].join(" ");
}

export interface CategoryGroup {
  category: Category;
  about: string;
  operations: Operation[];
}

/** Operations grouped by category, in the order the categories are declared. */
export function byCategory(only?: Category): CategoryGroup[] {
  return (Object.keys(OPERATION_GROUPS) as Category[])
    .filter((kind_) => only === undefined || kind_ === only)
    .map((kind_) => ({
      category: kind_,
      about: OPERATION_GROUPS[kind_],
      operations: OPERATIONS.filter((label) => label.category === kind_),
    }));
}

export function isCategory(input: unknown): input is Category {
  return typeof input === "string" && Object.hasOwn(OPERATION_GROUPS, input);
}
