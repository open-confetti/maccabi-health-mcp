/**
 * Maccabi's public provider directory: doctors, and laboratories and therapists. No account and no
 * cookies are involved; every request stands alone, the way the public site's own pages make them.
 */
import { createHash, randomUUID } from "node:crypto";
import { name, version } from "../../package.json";
import { ClientError, HttpFailure } from "./faults";
import { innerText, query, toDom } from "./html";
import { bytesUpTo, type Fetch, release, utf8Strictly } from "./http";
import { mediaType, type Reading } from "./member/shared";
import { type ProviderCard, shapeProviderCard } from "./provider-card";

export type { ProviderCard } from "./provider-card";

/**
 * The directory is told who is asking: this tool's name and version. (Requests to the member portal
 * set no User-Agent and go out with Node's default.) It is not dressed up as a browser. The host's
 * bot filter may still turn an honest name away, and pretending to be a browser is not something
 * this client will do.
 */
const CLIENT_NAME = `${name}/${version}`;

const SITE = "https://serguide.maccabi4u.co.il";
const API = `${SITE}/webapi/api`;
const DOCTORS_PAGE = `${SITE}/heb/doctors/`;
const SEARCH_API = `${API}/SearchPage/GetSearchPageSearch/`;
const SETTINGS_API = `${API}/SettingsForSearch/GetSettingsForSearch/`;
const CARD_API = `${API}/ProviderDetails/`;

const JSON_TYPE = "application/json";
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const INITIATOR = "001";

export type DirectoryKind = "doctors" | "labs-and-therapists";

/** How the public site names each kind: its chapter number, its module, and the settings it expects back. */
const KINDS: Record<DirectoryKind, { chapter: string; module: string; config: string }> = {
  doctors: { chapter: "001", module: "doctors", config: "Doctors_001" },
  "labs-and-therapists": { chapter: "003", module: "labsandtherapists", config: "LabsAndTherapists_003" },
};

export interface SpecialtyKey {
  field: string;
  label: string;
}
export interface CityKey {
  city: string;
  label: string;
}
export interface SearchFilter {
  city?: string;
  name?: string;
  page?: number;
}

const TEXT_COLUMNS = [
  "TITEL",
  "FIRST_NAME",
  "LAST_NAME",
  "SERVICE_NAME",
  ...([1, 2, 3, 4, 5, 6] as const).map((n) => `TREAT_AREA_${n}` as const),
  "CITY_NAME",
  "PARTIALLY_ADRESS",
] as const;

/** A search row as the public page displays it. The site's internal routing and booking parameters are left behind. */
export type ListedProvider = { reference: string } & Record<(typeof TEXT_COLUMNS)[number], string> & {
    PHONENUMBERS: { Title: string; Value: string }[];
  };

export interface DoctorResults {
  specialty: SpecialtyKey;
  providers: ListedProvider[];
  filters: { city?: CityKey; name?: string };
  coverage: {
    page: number;
    returned: number;
    reportedTotalItems: number;
    reportedTotalPages: number;
    pagingSupported: true;
  };
}
export interface SearchResults extends Omit<DoctorResults, "specialty"> {
  category: DirectoryKind;
  field: SpecialtyKey;
  /** The search that produced these rows. A detail read takes it together with a row's reference and repeats it. */
  selection: { category: DirectoryKind; field: string; options: SearchFilter };
}
export interface DirectorySetup {
  fetch?: Fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
/** What a search remembers about each row, to request its card and to check the card is that row's. */
interface RowIdentity {
  itemKey: string;
  position: number;
  employee: number;
  city: string;
  service: string;
}

const unexpected = (): HttpFailure => new HttpFailure("LISTING_UNEXPECTED_ANSWER");

/**
 * The host's bot filter stepped in: HTML arrived where JSON was due, or the doctors page arrived
 * without its search configuration. Either way no search took place, and this must never be
 * mistaken for a search that found nobody, which is why it has a code and a text of its own.
 */
const challenged = (): ClientError =>
  new ClientError(
    "LISTING_CHALLENGED",
    "The public directory's host answered with a bot-check page. No search was run and no provider was looked at, so this is not a search that found nobody. Repeating the call does not get past it. The member can search the official directory in a browser. This has nothing to do with the account session.",
  );

function record(input: unknown): Json {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw unexpected();
  return input as Json;
}

function text(input: unknown): string {
  if (typeof input !== "string" || input.length > 16_384) throw unexpected();
  return input;
}

function count(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) throw unexpected();
  return input;
}

/** An id the site sends either as a number or as a string of digits. */
function wholeNumber(input: unknown): number {
  const digits = typeof input === "string" && /^[0-9]+$/.test(input);
  if (typeof input !== "number" && !digits) throw unexpected();
  return count(Number(input));
}

function parsed(body: string): Json {
  try {
    return record(JSON.parse(body));
  } catch {
    throw unexpected();
  }
}

/** The furthest result page this client asks the site for. */
const LAST_PAGE = 1_000;

function isPageNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input > 0 && input <= LAST_PAGE;
}

/** A single key of the site's specialty or city list. The site also accepts several joined by commas; this does not. */
export function isCatalogKey(input: unknown): input is string {
  if (typeof input !== "string" || input.length === 0 || input.length > 128) return false;
  return !/[,\s\u0000-\u001f\u007f]/u.test(input);
}

/** The offset just past the quote that closes the string literal opened at `quote`; -1 if it is never closed. */
function endOfLiteral(source: string, quote: number): number {
  const stop = /["\\]/g;
  stop.lastIndex = quote + 1;
  for (let hit = stop.exec(source); hit !== null; hit = stop.exec(source)) {
    if (hit[0] === '"') return stop.lastIndex;
    // A backslash takes the character after it along, whichever it is.
    stop.lastIndex += 1;
  }
  return -1;
}

/** The offset just past the brace that closes the object literal opening at `open`; -1 if nothing closes it. */
function endOfObject(source: string, open: number): number {
  const mark = /[{}"]/g;
  mark.lastIndex = open;
  let unclosed = 0;
  for (let hit = mark.exec(source); hit !== null; hit = mark.exec(source)) {
    const [found] = hit;
    if (found === '"') {
      // Braces inside a string are text, so the scan resumes after the literal.
      const past = endOfLiteral(source, hit.index);
      if (past === -1) return -1;
      mark.lastIndex = past;
      continue;
    }
    unclosed += found === "{" ? 1 : -1;
    if (found === "}" && unclosed === 0) return mark.lastIndex;
  }
  return -1;
}

/**
 * The doctors page carries its search configuration as one JSON object assigned in an inline script.
 * That object is cut out and parsed as data; the script around it is never run.
 */
function doctorsPageData(markup: string): Json {
  const assignment = /\b__INITIAL_STATE__\s*=\s*/g;
  const scripts = query("script:not([src])", toDom(markup))
    .map((script) => innerText(script))
    .filter((script) => /\b__INITIAL_STATE__\s*=/.test(script));
  if (scripts.length === 0) throw challenged();
  const [script, ...others] = scripts as [string, ...string[]];
  const found = [...script.matchAll(assignment)];
  const [only] = found;
  if (others.length > 0 || found.length !== 1 || !only) throw unexpected();
  const open = only.index + only[0].length;
  const close = script[open] === "{" ? endOfObject(script, open) : -1;
  if (close < 0 || !/^\s*;/.test(script.slice(close))) throw unexpected();
  const doctors = record(record(parsed(script.slice(open, close)).settings).doctors);
  if (record(doctors.Settings).category !== KINDS.doctors.config) throw unexpected();
  return record(doctors.Data);
}

/** The site's list of specialties (`Fields`) or cities (`Cities`): unique keys, each with a display name. */
function keyedList(settings: Json, which: "Fields" | "Cities"): { key: string; label: string }[] {
  const listed = settings[which];
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > 2_000) throw unexpected();
  const keys = new Set<string>();
  return listed.map((item) => {
    const { K: key, V: label } = record(item);
    const usableLabel = typeof label === "string" && label.trim() !== "" && label.length <= 1_024;
    if (!isCatalogKey(key) || keys.has(key) || !usableLabel) throw unexpected();
    keys.add(key);
    return { key, label: label as string };
  });
}

/** A reference that stays the same for a provider from one search to the next and gives nothing of the site's keys away. */
function referenceFor(kind_: DirectoryKind, employee: number, position: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([kind_, employee, position]))
    .digest("hex");
  return `provider-${digest.slice(0, 32)}`;
}

/** A search answer that reports success and whose counts are consistent with the rows it carries. */
function searchAnswer(body: string): Json {
  const answer = parsed(body);
  const { Errors: errors, Items: items } = answer;
  if (!Array.isArray(errors)) throw unexpected();
  if (answer.Success !== true || errors.length > 0) throw new HttpFailure("LISTING_SEARCH_FAILED");
  if (!Array.isArray(items) || items.length > 100 || count(answer.TotalItems) < items.length) throw unexpected();
  count(answer.NumOfPages);
  return answer;
}

function reading<T>(payload: T, label: string): Reading<T> {
  return {
    data: payload,
    retrievedAt: new Date().toISOString(),
    source: {
      service: "PublicDirectory",
      operation: label,
      completeness: "upstream-response",
      schemaEvidence: "frontend-field-projection",
    },
  };
}

/** Searches the directory the way its public results page does, optional filters and paging included. */
export class ProviderDirectory {
  readonly #send: Fetch;
  readonly #deadlineMs: number;

  constructor({ fetch, timeoutMs }: DirectorySetup = {}) {
    const deadlineMs = timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new HttpFailure("BAD_DEADLINE");
    this.#send = fetch ?? globalThis.fetch;
    this.#deadlineMs = deadlineMs;
  }

  async allProviderFields(kind_: DirectoryKind): Promise<Reading<SpecialtyKey[]>> {
    const fields = keyedList(await this.#settings(kind_), "Fields");
    return reading(
      fields.map(({ key, label }) => ({ field: key, label })),
      "directory-specialties",
    );
  }

  async allProviderCities(kind_: DirectoryKind): Promise<Reading<CityKey[]>> {
    const cities = keyedList(await this.#settings(kind_), "Cities");
    return reading(
      cities.map(({ key, label }) => ({ city: key, label })),
      "directory-cities",
    );
  }

  async search(kind_: DirectoryKind, column: string, opts: SearchFilter = {}): Promise<Reading<SearchResults>> {
    const { result } = await this.#find(kind_, column, opts);
    return reading(result, "directory-search");
  }

  /**
   * One provider's card. The search is run again and the reference must be among its rows; the card
   * that comes back must then describe that same row, or it is refused.
   */
  async fetchProviderDetails(
    kind_: DirectoryKind,
    column: string,
    handle: string,
    opts: SearchFilter = {},
  ): Promise<Reading<ProviderCard>> {
    const { chapter } = this.#kind(kind_);
    if (typeof handle !== "string" || !/^provider-[a-f0-9]{32}$/.test(handle))
      throw new HttpFailure("LISTING_BAD_REFERENCE");
    const { rows, requestId } = await this.#find(kind_, column, opts);
    const row = rows.get(handle);
    if (!row) throw new HttpFailure("LISTING_REFERENCE_GONE");
    const card = parsed(
      await this.#fetchText(CARD_API, JSON_TYPE, {
        ItemKeyIndex: row.itemKey,
        Source: "SearchPageResults",
        RequestId: requestId,
        ChapterId: chapter,
        InitiatorCode: INITIATOR,
        IsKosher: 0,
        IsMobileApplication: 0,
      }),
    );
    if (card.Success !== true || card.ErrorCode !== 0) throw new HttpFailure("LISTING_CARD_FAILED");
    // A laboratory or therapist row may have no employee number, and its card then has an empty one.
    const noEmployee = kind_ === "labs-and-therapists" && row.employee === 0;
    const sameRow =
      card.Chapter_Code === chapter &&
      wholeNumber(card.PositionId) === row.position &&
      (noEmployee ? card.Pernr === "" : wholeNumber(card.Pernr) === row.employee) &&
      card.City_Name === row.city &&
      card.Service_Name === row.service;
    if (!sameRow) throw unexpected();
    return reading(shapeProviderCard(card, handle), "directory-provider");
  }

  #kind(kind_: DirectoryKind): (typeof KINDS)[DirectoryKind] {
    if (kind_ === "doctors" || kind_ === "labs-and-therapists") return KINDS[kind_];
    throw new HttpFailure("LISTING_BAD_KIND");
  }

  /** The search settings of a kind. Doctors' are embedded in their page; the other kind has an endpoint. */
  async #settings(kind_: DirectoryKind): Promise<Json> {
    const { module, config } = this.#kind(kind_);
    if (kind_ === "doctors") return doctorsPageData(await this.#fetchText(DOCTORS_PAGE, "text/html"));
    const body = await this.#fetchText(SETTINGS_API, JSON_TYPE, { ModuleName: module, initiatorCode: INITIATOR });
    const answer = parsed(body);
    if (record(answer.Settings).category !== config) throw unexpected();
    return record(answer.Data);
  }

  async #find(
    kind_: DirectoryKind,
    column: string,
    opts: SearchFilter,
  ): Promise<{ result: SearchResults; rows: Map<string, RowIdentity>; requestId: string }> {
    const { chapter, module } = this.#kind(kind_);
    const { city: cityKey, name: nameFilter } = opts;
    const page = opts.page ?? 1;
    if (!isCatalogKey(column)) throw new HttpFailure("LISTING_BAD_SPECIALTY");
    if (!isPageNumber(page)) throw new HttpFailure("LISTING_BAD_PAGE");
    if (cityKey !== undefined && !isCatalogKey(cityKey)) throw new HttpFailure("LISTING_BAD_CITY");
    const nameIsUsable =
      typeof nameFilter === "string" &&
      nameFilter.trim() !== "" &&
      nameFilter.length <= 200 &&
      !/[\u0000-\u001f\u007f]/u.test(nameFilter);
    if (nameFilter !== undefined && !nameIsUsable) throw new HttpFailure("LISTING_BAD_NAME");

    // Both filters must be entries of the site's own lists before anything is searched.
    const settings = await this.#settings(kind_);
    const specialty = keyedList(settings, "Fields").find((entry) => entry.key === column);
    if (!specialty) throw new HttpFailure("LISTING_UNKNOWN_SPECIALTY");
    const city =
      cityKey === undefined ? undefined : keyedList(settings, "Cities").find((entry) => entry.key === cityKey);
    if (cityKey !== undefined && !city) throw new HttpFailure("LISTING_UNKNOWN_CITY");

    const requestId = randomUUID();
    const firstPage = {
      Field: column,
      ...(city && { City: city.key }),
      ...(nameFilter !== undefined && { DocName: nameFilter }),
      ChapterId: chapter,
      InitiatorCode: INITIATOR,
      isKosher: 0,
      IsMobileApplication: 0,
      PageNumber: 1,
      RequestId: requestId,
    };
    let answer = searchAnswer(await this.#fetchText(SEARCH_API, JSON_TYPE, firstPage));
    if (page > 1) {
      if (page > count(answer.NumOfPages)) throw new HttpFailure("LISTING_PAGE_PAST_END");
      // The site's "next" button repeats the search under the same request id, with the page number
      // and these two extra fields, and must land on the tab the first page was on.
      const tab = answer.SelectedTab;
      if (tab !== null && (typeof tab !== "string" || !/^[1-9][0-9]?$/.test(tab))) throw unexpected();
      const laterPage = { ...firstPage, PageNumber: page, Source: "SearchPage", ModuleName: `${module}searchresults` };
      answer = searchAnswer(await this.#fetchText(SEARCH_API, JSON_TYPE, laterPage));
      if (answer.SelectedTab !== tab || count(answer.NumOfPages) < page) throw unexpected();
    }

    const rows = new Map<string, RowIdentity>();
    const providers = (answer.Items as unknown[]).map((item): ListedProvider => {
      const row = record(item);
      const { PHONENUMBERS: phones, ItemKeyIndex: itemKey } = row;
      if (row.CHAPTER_CODE !== chapter || !Array.isArray(phones) || phones.length > 50) throw unexpected();
      const position = wholeNumber(row.PositionId);
      const employee = wholeNumber(row.EmployeeNumber);
      if (position <= 0 || typeof itemKey !== "string" || itemKey === "" || itemKey.length > 8_192) throw unexpected();
      const reference = referenceFor(kind_, employee, position);
      if (rows.has(reference)) throw unexpected();
      const columns = Object.fromEntries(TEXT_COLUMNS.map((title) => [title, text(row[title])]));
      const provider = {
        reference,
        ...columns,
        PHONENUMBERS: phones.map((phone) => {
          const { Title, Value } = record(phone);
          return { Title: text(Title), Value: text(Value) };
        }),
      } as ListedProvider;
      rows.set(reference, { itemKey, position, employee, city: provider.CITY_NAME, service: provider.SERVICE_NAME });
      return provider;
    });

    const result: SearchResults = {
      category: kind_,
      field: { field: specialty.key, label: specialty.label },
      selection: { category: kind_, field: column, options: { ...opts, page } },
      providers,
      filters: {
        ...(city && { city: { city: city.key, label: city.label } }),
        ...(nameFilter !== undefined && { name: nameFilter }),
      },
      coverage: {
        page,
        returned: providers.length,
        reportedTotalItems: count(answer.TotalItems),
        reportedTotalPages: count(answer.NumOfPages),
        pagingSupported: true,
      },
    };
    return { result, rows, requestId };
  }

  /** One request, answered with a 200 of exactly the expected type from exactly the address asked, as strict UTF-8. */
  async #fetchText(address: string, mime: string, sent?: object): Promise<string> {
    const headers: Record<string, string> = { "User-Agent": CLIENT_NAME, Accept: mime };
    const setup: RequestInit = { method: "GET", credentials: "omit", redirect: "manual", headers };
    if (sent) {
      setup.method = "POST";
      setup.body = JSON.stringify(sent);
      headers["Content-Type"] = JSON_TYPE;
    }
    let reply: Response;
    try {
      reply = await this.#send(address, { ...setup, signal: AbortSignal.timeout(this.#deadlineMs) });
    } catch (caught) {
      const kind = caught instanceof Error ? caught.name : undefined;
      if (kind === "TimeoutError") throw new HttpFailure("TIMED_OUT");
      throw new HttpFailure(kind === "AbortError" ? "REQUEST_CANCELLED" : "LISTING_UNREACHABLE");
    }
    const refusal = this.#whyRefused(reply, address, mime);
    if (refusal) {
      await release(reply);
      throw refusal;
    }
    return utf8Strictly(await bytesUpTo(reply, MAX_ANSWER_BYTES, unexpected()), unexpected());
  }

  #whyRefused(reply: Response, address: string, mime: string): Error | undefined {
    if (reply.status !== 200) return new HttpFailure("LISTING_HTTP_ERROR", reply.status);
    if (reply.url && reply.url !== address) return unexpected();
    const served = mediaType(reply);
    if (served !== mime) return served === "text/html" ? challenged() : unexpected();
    return reply.body ? undefined : unexpected();
  }
}
