import * as z from "zod/v4";
import { DATA_KINDS, type DataKind } from "../maccabi/kinds";
import { CatalogRefusal, listCatalog, vetCatalogRequest } from "../maccabi/member/parse/catalog";
import { custom, document, type Operation, read } from "./define";
import { reference } from "./inputs";

const kind_ = "portal" as const;

const target = z.string().min(1).max(128).describe("An endpoint name from `portal-endpoints`.");
const args = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .optional()
  .describe("The endpoint's own parameters, as listed by `portal-endpoints`. Owner ids are filled in automatically.");

type PortalInput = { endpoint: string; params?: Record<string, string>; reference?: string };

/** Refuses a request the catalog would refuse, before any session is opened. */
function catalogRule(given: PortalInput, wants: "json" | "document"): string | undefined {
  let line: ReturnType<typeof vetCatalogRequest>;
  try {
    line = vetCatalogRequest(given.endpoint, given.params ?? {});
  } catch (caught) {
    if (caught instanceof CatalogRefusal) return caught.message;
    throw caught;
  }
  if (wants === "json" && line.pdf) return `${line.name} is a document; use \`portal-document\`.`;
  if (wants === "document" && !line.pdf && given.reference === undefined) {
    return `${line.name} returns JSON; pass a \`*_reference\` from \`portal\` with the same endpoint and parameters.`;
  }
  return undefined;
}

const dataCategories = Object.keys(DATA_KINDS) as [DataKind, ...DataKind[]];

export const portal: Operation[] = [
  custom({
    name: "portal-endpoints",
    category: kind_,
    summary: "The allowlisted portal endpoints `portal` can read, with their parameters.",
    description: "Static data: no session and no request.",
    input: { category: z.enum(dataCategories).optional().describe("Keep one category.") },
    access: "offline",
    returns: "json",
    run: (_sources, given) => ({ endpoints: listCatalog(given.category) }),
  }),
  read({
    name: "portal",
    category: kind_,
    summary: "Read one allowlisted portal endpoint by name.",
    description:
      "For reads the named operations do not cover. Only catalog names resolve, and ids that must be the member's own are checked against a fresh list first. Rows with a document carry a `*_reference` for `portal-document`.",
    input: { endpoint: target, params: args },
    check: (given) => catalogRule(given, "json"),
    run: (member, given) => member.portal.readCatalog(given.endpoint, given.params ?? {}),
  }),
  document({
    name: "portal-document",
    category: kind_,
    summary: "The document behind a `*_reference` from `portal`, or a document-only endpoint.",
    input: {
      endpoint: target,
      params: args,
      reference: reference.optional().describe("A `*_reference` from `portal` with the same endpoint and parameters."),
    },
    check: (given) => catalogRule(given, "document"),
    run: (member, given) => member.portal.fetchPortalDocumentPdf(given.endpoint, given.params ?? {}, given.reference),
  }),
];
