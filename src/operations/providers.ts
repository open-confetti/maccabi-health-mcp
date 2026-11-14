import * as z from "zod/v4";
import { isCatalogKey } from "../maccabi/provider-directory";
import { custom, type Operation, read } from "./define";
import { provider as clinic, israelNow, localDateTime } from "./inputs";

const kind_ = "providers" as const;

const PUBLIC = "Public directory: no account, no session, no cookies.";

const directoryKind = z
  .enum(["doctors", "labs-and-therapists"])
  .describe("`doctors`, or `labs-and-therapists` for labs, institutes and therapists.");

const catalogKey = z.string().refine(isCatalogKey, "Copy one key exactly as the directory returned it.");

const search = {
  category: directoryKind,
  field: catalogKey.describe("A `field` key from `directory-specialties`, same category."),
  city: catalogKey.optional().describe("A `city` key from `directory-cities`, same category."),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (candidate) => candidate.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(candidate),
      "Use plain text without control characters.",
    )
    .optional()
    .describe("Part of a provider's name."),
  page: z.number().int().min(1).max(1000).optional().describe("Result page, 1 by default."),
};

function searchOptions(given: { city?: string; name?: string; page?: number }) {
  return {
    ...(given.city === undefined ? {} : { city: given.city }),
    ...(given.name === undefined ? {} : { name: given.name }),
    ...(given.page === undefined ? {} : { page: given.page }),
  };
}

export const providers: Operation[] = [
  read({
    name: "assigned-doctor",
    category: kind_,
    summary: "The member's assigned doctor at a given moment.",
    input: {
      at: z
        .preprocess(
          // A bare date stands for the middle of that day, so it names the same day in any timezone.
          (given) => (typeof given === "string" && /^\d{4}-\d{2}-\d{2}$/.test(given) ? `${given}T12:00:00` : given),
          localDateTime,
        )
        .optional()
        .describe("Portal-local time, YYYY-MM-DDTHH:mm:ss, or a date (noon that day). Default: now, Israel time."),
    },
    run: (member, given) => member.appointments.fetchAscribedProvider(given.at ?? israelNow()),
  }),
  read({
    name: "recent-providers",
    category: kind_,
    summary: "Providers the member visited recently.",
    description:
      "Each row's `object_type`, `object_id` and `employee_id` identify it to the appointment operations. Adult accounts only.",
    rows: "data",
    run: (member) => member.appointments.allRecentProviders(),
  }),
  read({
    name: "provider",
    category: kind_,
    summary: "One recent provider's card: clinic address, phones, specialties.",
    input: clinic,
    run: (member, given) => member.appointments.fetchAppointmentProvider(given),
  }),
  custom({
    name: "directory-specialties",
    category: kind_,
    summary: "The specialty keys the public directory can be searched by.",
    description: PUBLIC,
    input: { category: directoryKind },
    access: "public",
    returns: "json",
    run: (sources, given) => sources.directory().allProviderFields(given.category),
  }),
  custom({
    name: "directory-cities",
    category: kind_,
    summary: "The city keys the public directory can be searched by.",
    description: PUBLIC,
    input: { category: directoryKind },
    access: "public",
    returns: "json",
    run: (sources, given) => sources.directory().allProviderCities(given.category),
  }),
  custom({
    name: "directory-search",
    category: kind_,
    summary: "Search public doctors, labs, institutes and therapists.",
    description: `${PUBLIC} Each provider carries a \`reference\` for \`directory-provider\`. A bot-challenge answer is reported as an error, never as an empty list.`,
    input: search,
    access: "public",
    returns: "json",
    run: (sources, given) => sources.directory().search(given.category, given.field, searchOptions(given)),
  }),
  custom({
    name: "directory-provider",
    category: kind_,
    summary: "One public provider: contacts, hours, services, remarks.",
    description: `${PUBLIC} Repeat the search arguments the reference came from; the search is re-run to locate the provider.`,
    input: {
      ...search,
      reference: z
        .string()
        .regex(/^provider-[a-f0-9]{32}$/, "Copy `providers[].reference` exactly as `directory-search` returned it.")
        .describe("`providers[].reference` from `directory-search`."),
    },
    access: "public",
    returns: "json",
    run: (sources, given) =>
      sources.directory().fetchProviderDetails(given.category, given.field, given.reference, searchOptions(given)),
  }),
];
