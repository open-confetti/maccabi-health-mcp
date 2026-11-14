import * as z from "zod/v4";
import { DATA_KINDS } from "../maccabi/kinds";
import type { Member } from "../maccabi/member";
import type { ProviderDirectory } from "../maccabi/provider-directory";

/** Every operation is filed under exactly one of these, so a caller can tell clinical data from the rest. */
export const OPERATION_GROUPS = {
  ...DATA_KINDS,
  portal:
    "Any other allowlisted portal read, addressed by endpoint name. Each endpoint has a data category of its own.",
} as const;

export type Category = keyof typeof OPERATION_GROUPS;

/** What a handler may reach. A member is opened lazily, only by operations that need the account. */
export interface Sources {
  member(): Promise<Member>;
  directory(): ProviderDirectory;
}

/** `member` needs a signed-in session, `public` talks to the anonymous directory, `offline` makes no request. */
export type Access = "member" | "public" | "offline";

/** What a handler returns before the surfaces render it. */
export type FileType = "application/pdf" | "image/jpeg" | "application/octet-stream";
export interface FileOutput {
  bytes: Uint8Array;
  mimeType: FileType;
  /** JSON printed beside the file: provenance, and anything needed to interpret the bytes. */
  details: Record<string, unknown>;
}

export interface Operation {
  /** Kebab-case. The CLI command and the value of the MCP `operation` argument. */
  name: string;
  category: Category;
  /** One short line for the index. */
  summary: string;
  /** Where the arguments come from and what the result does not claim. Only what a caller needs. */
  description?: string;
  access: Access;
  /** A strict object schema; its keys become CLI flags (`request_id` is `--request-id`). */
  input: z.ZodObject;
  returns: "json" | "file";
  /** Path of the row array inside the result (`data` or `data.tests`) when the result can be paged locally. */
  rows?: string;
  run(sources: Sources, given: never): Promise<unknown>;
}

interface Spec<Shape extends z.ZodRawShape> {
  name: string;
  category: Category;
  summary: string;
  description?: string;
  input?: Shape;
  /** Cross-field rules that a per-field schema cannot express. Return a message to refuse the input. */
  check?: (given: z.infer<z.ZodObject<Shape>>) => string | undefined;
}

type Input<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

/** Local slicing of a fetched list. It never asks the portal for further pages. */
const paging = {
  limit: z.number().int().min(1).max(1000).optional().describe("Return at most this many rows of the fetched list."),
  offset: z.number().int().min(0).optional().describe("Skip this many rows first."),
};

function schema<Shape extends z.ZodRawShape>(rule: Spec<Shape>, paged: boolean): z.ZodObject {
  const asObject = z.strictObject({ ...rule.input, ...(paged ? paging : {}) });
  const check = rule.check;
  if (!check) return asObject;
  return asObject.superRefine((candidate, context) => {
    const problem = check(candidate as Input<Shape>);
    if (problem) context.addIssue({ code: "custom", message: problem });
  }) as unknown as z.ZodObject;
}

function base<Shape extends z.ZodRawShape>(rule: Spec<Shape>, paged = false) {
  return {
    name: rule.name,
    category: rule.category,
    summary: rule.summary,
    ...(rule.description ? { description: rule.description } : {}),
    input: schema(rule, paged),
  };
}

/** A JSON read of the signed-in member's own data. `rows` marks a list that can be sliced with limit/offset. */
export function read<Shape extends z.ZodRawShape>(
  rule: Spec<Shape> & { rows?: string; run: (member: Member, given: Input<Shape>) => unknown },
): Operation {
  return {
    ...base(rule, rule.rows !== undefined),
    access: "member",
    returns: "json",
    ...(rule.rows ? { rows: rule.rows } : {}),
    run: async (sources, given) => rule.run(await sources.member(), given),
  };
}

interface Bytes {
  data: Uint8Array;
  retrievedAt: string;
  source: unknown;
}

/** An original document of the signed-in member, returned as bytes. */
export function document<Shape extends z.ZodRawShape>(
  rule: Spec<Shape> & { mimeType?: FileType; run: (member: Member, given: Input<Shape>) => Promise<Bytes> },
): Operation {
  return {
    ...base(rule),
    access: "member",
    returns: "file",
    run: async (sources, given): Promise<FileOutput> => {
      const file = await rule.run(await sources.member(), given);
      return {
        bytes: file.data,
        mimeType: rule.mimeType ?? "application/pdf",
        details: { retrievedAt: file.retrievedAt, source: file.source },
      };
    },
  };
}

/** An operation with its own access level and output handling. */
export function custom<Shape extends z.ZodRawShape>(
  rule: Spec<Shape> & {
    access: Access;
    returns: "json" | "file";
    run: (sources: Sources, given: Input<Shape>) => unknown;
  },
): Operation {
  return {
    ...base(rule),
    access: rule.access,
    returns: rule.returns,
    run: async (sources, given) => rule.run(sources, given),
  };
}
