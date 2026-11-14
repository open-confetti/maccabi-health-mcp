/** Reads through the portal catalog: one allowlisted call by name, and the documents its answer points at. */
import { refuse } from "../faults";
import type { MemberScope } from "./context";
import {
  type CatalogEntry,
  CatalogRefusal,
  type CatalogScope,
  catalogPath,
  type DocumentRoute,
  EMBEDDED_PDF,
  fillCatalogRequest,
} from "./parse/catalog";
import {
  CHECKSUM_KEYS,
  type Fields,
  getJson,
  holdsChecksum,
  isLinkKey,
  isOpenLink,
  isReference,
  MAX_PDF_BYTES,
  mustBelongToMemberDeep,
  pdfFromBase64,
  type Reading,
  SteadyReferences,
  steadyIdentity,
  todayLocal,
} from "./shared";

/** A catalog request once its defaults are in, together with the member facts it was filled from. */
interface Prepared {
  entry: CatalogEntry;
  values: Record<string, string>;
  facts: CatalogScope;
}
interface Shaped {
  data: unknown;
  /** Reference → where that document downloads from. It lives for one read and is never returned. */
  documents: Map<string, DocumentRoute>;
}

const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_DEPTH = 32;
/** Lists of the member's own things are shallow; a row is not looked for any deeper than this. */
const MAX_ROW_DEPTH = 8;
/** A value that starts like a URL or a path, encoded or not, whatever its field happens to be called. */
const LOOKS_LIKE_LINK = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|%2F)/i;

export class Portal {
  constructor(private readonly scope: MemberScope) {}

  /**
   * The answer of one catalog entry with nothing projected away. What is taken out is the member
   * checksum, and further down the output filter drops ids of other people. Every object that carries
   * a document gains an opaque `*_reference`, which `fetchPortalDocumentPdf` accepts for as long as the
   * same entry and arguments still list that document.
   */
  async readCatalog(name: string, args: Record<string, string> = {}): Promise<Reading<unknown>> {
    const request = this.prepare(name, args);
    const { entry } = request;
    if (entry.pdf) throw new CatalogRefusal("pdf-only", `${entry.name} is a PDF; \`portal-document\` reads it.`);
    const { data } = this.shape(request, await this.answer(request));
    return this.scope.result(data, entry.service, entry.name);
  }

  /**
   * A PDF: the whole answer of a document-only entry, or else the document a reference stands for. A
   * reference is not looked up anywhere. The entry is read again with the same arguments and the
   * reference has to turn up in that fresh answer.
   */
  async fetchPortalDocumentPdf(
    name: string,
    args: Record<string, string> = {},
    reference?: string,
  ): Promise<Reading<Uint8Array>> {
    const request = this.prepare(name, args);
    const { entry } = request;
    const label = `${entry.name}-pdf`;
    if (entry.pdf) {
      if (reference !== undefined) {
        throw new CatalogRefusal("pdf-only", `${entry.name} is a PDF as a whole, so there is no reference to pass.`);
      }
      await this.mustBeMembersOwn(request);
      return this.scope.pdfAt(catalogPath(entry, request.values, request.facts), entry.service, label);
    }
    if (typeof reference !== "string" || !isReference(reference)) {
      throw refuse("NOT_THE_MEMBERS", label, "reference-malformed");
    }
    const route = this.shape(request, await this.answer(request)).documents.get(reference);
    if (!route) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    if ("path" in route) return this.scope.pdfAt(route.path, entry.service, label);
    // Judged on the text, so an oversized file is turned away before it is decoded.
    if (route.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4)
      throw refuse("UNEXPECTED_ANSWER", label, "file:oversized");
    return this.scope.result(pdfFromBase64(route.base64, label), entry.service, label);
  }

  private prepare(name: string, args: Record<string, string>): Prepared {
    const { owner, profile, bootstrap } = this.scope;
    const facts: CatalogScope = {
      memberId: owner.memberId,
      memberIdCode: owner.memberIdCode,
      sex: profile.sex,
      birthDate: profile.birth_date.slice(0, 10),
      today: todayLocal(),
      insurancesGroups: bootstrap.insurancesGroups,
    };
    if (bootstrap.age && typeof bootstrap.age === "object") facts.age = bootstrap.age;
    if (typeof bootstrap.remarkCodes === "string") facts.remarkCodes = bootstrap.remarkCodes;
    return { ...fillCatalogRequest(name, args, facts), facts };
  }

  /**
   * Holds an entry's bound arguments to what the member has. The entry named by each binding is read
   * now, with its own checks, and unless one of its rows carries all the bound values together the
   * request stops here, with none of those values sent anywhere.
   */
  private async mustBeMembersOwn({ entry, values }: Prepared): Promise<void> {
    for (const { source, fields } of entry.bind ?? []) {
      const wanted: [field: string, value: string][] = [];
      for (const [param, field] of Object.entries(fields)) {
        const value = values[param];
        if (value !== undefined && value !== "") wanted.push([field, value]);
      }
      if (wanted.length === 0) continue;
      const listed = await this.answer(this.prepare(source, {}));
      if (!hasRow(listed, wanted, 0)) throw refuse("NOT_THE_MEMBERS", entry.name, "id-unknown");
    }
  }

  private async answer(request: Prepared): Promise<unknown> {
    await this.mustBeMembersOwn(request);
    const { entry, values, facts } = request;
    const path = catalogPath(entry, values, facts, { checksum: this.scope.memberChecksum });
    const sending = entry.method === "POST" ? this.scope.post(entry.body(values, facts)) : undefined;
    const answer = await getJson(this.scope.http, path, entry.name, sending, true);
    if (entry.owner !== "family") mustBelongToMemberDeep(answer, this.scope.owner, entry.name);
    return answer;
  }

  /**
   * Copies an answer field for field. Maccabi's short-lived links stay, signatures and timestamps
   * included, with these exceptions: a checksum field is skipped, a link that spells the checksum out
   * is withheld, and embedded PDF bytes give way to a reference or a `base64_present` flag. References
   * are derived from what identifies a row and never from its link, because the link changes with every
   * read. Where a private link has no document rule to download it, `<field>_present` says it exists.
   */
  private shape({ entry, facts }: Prepared, answer: unknown): Shaped {
    const documents = new Map<string, DocumentRoute>();
    const references = new SteadyReferences();
    const rules = [...(entry.documents ?? []), EMBEDDED_PDF];
    const checksum = this.scope.memberChecksum;

    /** A new object that so far holds only the references of the documents `row` carries. */
    const referencesOf = (row: Fields, where: string): Fields => {
      const found: Fields = {};
      for (const rule of rules) {
        const route = rule.locate(row, where, facts);
        if (!route) continue;
        const identity = ["portal-document", entry.name, rule.kind, where, ...steadyIdentity(row)];
        const reference = references.next(identity);
        if (documents.has(reference)) throw refuse("UNEXPECTED_ANSWER", entry.name, "row-twice");
        documents.set(reference, route);
        found[rule.key] = reference;
      }
      return found;
    };

    const copy = (node: unknown, where: string, depth: number): unknown => {
      if (depth > MAX_ANSWER_DEPTH) throw refuse("UNEXPECTED_ANSWER", entry.name, "nesting-too-deep");
      if (Array.isArray(node)) return node.map((inner) => copy(inner, `${where}[]`, depth + 1));
      if (!node || typeof node !== "object") return node;
      const row = node as Fields;
      const out = referencesOf(row, where);
      // Both are settled before any field is copied: a field could itself be named like a reference.
      const downloadable = Object.keys(out).length > 0;
      const embedded = Object.hasOwn(out, EMBEDDED_PDF.key);
      for (const [key, field] of Object.entries(row)) {
        if (CHECKSUM_KEYS.has(key.toLowerCase())) continue;
        if (key === "base64") {
          if (!embedded) out.base64_present = typeof field === "string" && field.length > 0;
        } else if (isPrivateLink(key, field)) {
          if (!downloadable) out[`${key}_present`] = true;
          if (!holdsChecksum(field, checksum)) out[key] = field;
        } else {
          out[key] = copy(field, `${where}.${key}`, depth + 1);
        }
      }
      return out;
    };

    const copied = copy(answer, "$", 0);
    const size = Buffer.byteLength(JSON.stringify(copied ?? null));
    if (size > MAX_ANSWER_BYTES) throw refuse("UNEXPECTED_ANSWER", entry.name, "oversized");
    return { data: copied, documents };
  }
}

const isPrivateLink = (key: string, field: unknown): field is string =>
  typeof field === "string" &&
  field.length > 0 &&
  (isLinkKey(key) || LOOKS_LIKE_LINK.test(field)) &&
  !isOpenLink(field);

/** Whether some object inside `answer` has every wanted field, each one equal as text to its wanted value. */
function hasRow(answer: unknown, wanted: readonly (readonly [field: string, value: string])[], depth: number): boolean {
  if (depth > MAX_ROW_DEPTH || !answer || typeof answer !== "object") return false;
  if (!Array.isArray(answer)) {
    const row = answer as Fields;
    const holds = ([field, value]: readonly [string, string]): boolean => {
      if (!Object.hasOwn(row, field)) return false;
      const held = row[field];
      return held !== null && held !== undefined && String(held) === value;
    };
    if (wanted.every(holds)) return true;
  }
  return Object.values(answer).some((inner) => hasRow(inner, wanted, depth + 1));
}
