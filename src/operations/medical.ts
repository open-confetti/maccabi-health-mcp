import * as z from "zod/v4";
import { custom, document, type FileOutput, type Operation, read } from "./define";
import {
  date,
  dateRange,
  gridPage,
  id,
  labRow,
  labTest,
  labTestChoice,
  labTestRule,
  optionalDateRange,
  orderedRange,
  range,
  reference,
  uidText,
} from "./inputs";

const kind_ = "medical" as const;

const image = {
  study_uid: uidText.describe("`request_id` of a `scans` row."),
  series_uid: uidText.describe("`seriesInstanceUID` from `scan`."),
  image_uid: uidText.describe("`sopInstanceUID` from `scan`."),
};

const hospitalRange = {
  as_of: date.describe("The day the lookback is counted from, normally today."),
  ...optionalDateRange,
};

function hospitalRule(given: { as_of: string; from?: string; to?: string }): string | undefined {
  const problem = orderedRange(given);
  if (problem) return problem;
  return given.to !== undefined && given.to > given.as_of ? "`to` must not be later than `as_of`." : undefined;
}

const labs: Operation[] = [
  read({
    name: "test-results",
    category: kind_,
    summary: "List test results: laboratory, imaging and other rows, newest first.",
    description:
      "Each row carries `request_id` and `doc_id` for the other lab operations, and `has_document` when a file is attached. `year` filters the fetched response by execution date; it does not fetch older pages.",
    input: { year: z.number().int().min(1000).max(9999).optional().describe("Keep rows executed in this year.") },
    rows: "data.tests",
    run: (member, given) => member.labs.allTests(given.year === undefined ? undefined : { year: given.year }),
  }),
  read({
    name: "lab-values",
    category: kind_,
    summary: "Read one laboratory result: values, units, reference ranges.",
    description: "Only laboratory rows have structured detail. Each analyte carries a `test_id`.",
    input: labRow,
    run: (member, given) => member.labs.fetchLabResult(given.request_id, given.doc_id),
  }),
  document({
    name: "lab-values-pdf",
    category: kind_,
    summary: "The printable report of one laboratory result.",
    description:
      "For laboratory rows only. Maccabi does not serve this report for some older results; `lab-values` still returns their values.",
    input: {
      ...labRow,
      irregular_only: z.boolean().optional().describe("Print only out-of-range rows, as the portal's checkbox does."),
    },
    run: (member, given) =>
      given.irregular_only
        ? member.labs.fetchLabReportPdf(given.request_id, given.doc_id, { irregularOnly: true })
        : member.labs.fetchLabReportPdf(given.request_id, given.doc_id),
  }),
  document({
    name: "test-document-pdf",
    category: kind_,
    summary: "The document attached to one test row.",
    description: "For rows with `has_document: true`. Laboratory results and imaging studies usually attach none.",
    input: labRow,
    run: (member, given) => member.labs.fetchImagingResultPdf(given.request_id, given.doc_id),
  }),
  document({
    name: "lab-covid-report-pdf",
    category: kind_,
    summary: "The English COVID report of one eligible laboratory result.",
    description:
      "Needs a result whose detail shows `show_print_corona_english_report`, and an account that already holds the English name and passport fields. Nothing is updated.",
    input: labRow,
    run: (member, given) => member.labs.fetchEnglishCovidLabReportPdf(given.request_id, given.doc_id),
  }),
  read({
    name: "lab-history",
    category: kind_,
    summary: "One analyte's current and past values.",
    description: "Often reaches further back than `test-results`. Not a claim of complete history.",
    input: labTest,
    check: labTestRule,
    run: (member, given) => member.labs.fetchLabComparison(labTestChoice(given)),
  }),
  document({
    name: "lab-history-pdf",
    category: kind_,
    summary: "One analyte's history as Maccabi's own list or graph PDF.",
    input: {
      ...labTest,
      view: z.enum(["list", "graph"]).default("list").describe("`graph` only when the results qualify for one."),
    },
    check: labTestRule,
    run: (member, given) => member.labs.fetchLabComparisonPdf(labTestChoice(given), given.view),
  }),
  document({
    name: "lab-analyte-pdf",
    category: kind_,
    summary: "The file attached to one analyte row.",
    description: "For analytes with `has_result_file`. This is one row's attachment, not the whole report.",
    input: labTest,
    check: labTestRule,
    run: (member, given) => member.labs.fetchLabResultFilePdf(labTestChoice(given)),
  }),
  read({
    name: "labs-latest",
    category: kind_,
    summary: "The latest laboratory results, grouped as the portal shows them.",
    description:
      "Each analyte carries a `test_id` for `lab-history` with source `latest`. Paging selects whole groups.",
    rows: "data",
    run: (member) => member.labs.allLatestLabResults(),
  }),
  document({
    name: "labs-latest-pdf",
    category: kind_,
    summary: "The latest laboratory results as one report.",
    input: { irregular_only: z.boolean().optional().describe("Print only out-of-range rows.") },
    run: (member, given) =>
      given.irregular_only
        ? member.labs.fetchLatestLabResultsPdf({ irregularOnly: true })
        : member.labs.fetchLatestLabResultsPdf(),
  }),
  read({
    name: "labs-followed",
    category: kind_,
    summary: "The laboratory tests the member follows.",
    description: "Each carries a `test_id` for `lab-history` with source `followed`. The follow list is never changed.",
    run: (member) => member.labs.allFollowedLabResults(),
  }),
  document({
    name: "labs-followed-pdf",
    category: kind_,
    summary: "The followed laboratory tests as one report.",
    run: (member) => member.labs.fetchFollowedLabResultsPdf(),
  }),
];

const imaging: Operation[] = [
  read({
    name: "scans",
    category: kind_,
    summary: "List imaging studies whose scans live in Maccabi's imaging viewer.",
    description: "A row's `request_id` is the study UID the other imaging operations take.",
    rows: "data",
    run: (member) => member.imaging.allImagingStudies(),
  }),
  read({
    name: "scan",
    category: kind_,
    summary: "One study's series and images.",
    input: { study_uid: image.study_uid },
    run: (member, given) => member.imaging.fetchImagingStudy(given.study_uid),
  }),
  read({
    name: "scan-image",
    category: kind_,
    summary: "DICOM metadata of one image.",
    input: image,
    run: (member, given) => member.imaging.fetchImagingImage(given.study_uid, given.series_uid, given.image_uid),
  }),
  document({
    name: "scan-preview",
    category: kind_,
    summary: "The viewer's preview JPEG of one image.",
    description: "A rendered preview, not the diagnostic image.",
    input: image,
    mimeType: "image/jpeg",
    run: (member, given) =>
      member.imaging.fetchImagingImageThumbnail(given.study_uid, given.series_uid, given.image_uid),
  }),
  custom({
    name: "scan-pixels",
    category: kind_,
    summary: "One image's raw pixel buffer, with the geometry needed to read it.",
    description:
      "A headerless, uncompressed buffer: not DICOM and not an image file. It is readable only with the returned geometry (rows, columns, samplesPerPixel, bitsAllocated, numberOfFrames).",
    input: image,
    access: "member",
    returns: "file",
    run: async (sources, given): Promise<FileOutput> => {
      const member = await sources.member();
      const file = await member.imaging.fetchImagingImagePixels(given.study_uid, given.series_uid, given.image_uid);
      const { pixels, ...geometry } = file.data;
      return {
        bytes: pixels,
        mimeType: "application/octet-stream",
        details: { geometry, retrievedAt: file.retrievedAt, source: file.source },
      };
    },
  }),
];

const visits: Operation[] = [
  read({
    name: "clinic-visits",
    category: kind_,
    summary: "List past visits.",
    description: "A row's `appointment_id` is the `id` the other visit operations take.",
    rows: "data",
    run: (member) => member.visits.allVisits(),
  }),
  read({
    name: "clinic-visit",
    category: kind_,
    summary: "Read one visit: summary, drugs, referrals, approvals, tutorials.",
    description:
      "`has_summary_pdf` says whether `clinic-visit-summary-pdf` applies. Attached rows that can be downloaded carry a `pdf_reference` for `clinic-visit-document-pdf`.",
    input: { id: id.describe("`appointment_id` of a `clinic-visits` row.") },
    run: (member, given) => member.visits.fetchVisit(given.id),
  }),
  document({
    name: "clinic-visit-summary-pdf",
    category: kind_,
    summary: "The summary document of one visit.",
    input: { id: id.describe("`appointment_id` of a `clinic-visits` row.") },
    run: (member, given) => member.visits.fetchVisitSummaryPdf(given.id),
  }),
  document({
    name: "clinic-visit-document-pdf",
    category: kind_,
    summary: "One document attached to a visit.",
    input: {
      id: id.describe("`appointment_id` of a `clinic-visits` row."),
      reference: reference.describe("A `pdf_reference` from `clinic-visit`."),
    },
    run: (member, given) => member.visits.fetchVisitDocumentPdf(given.id, given.reference),
  }),
  read({
    name: "hospital-visits",
    category: kind_,
    summary: "List hospital and emergency-room history.",
    description: "Without a range the portal's own lookback applies (three years observed). Rows carry a `reference`.",
    input: hospitalRange,
    check: hospitalRule,
    rows: "data",
    run: (member, given) => member.records.allHospitalHistory(given.as_of, range(given)),
  }),
  document({
    name: "hospital-visit-pdf",
    category: kind_,
    summary: "One hospital report.",
    description: "Pass the same `as_of` and range the row was listed with.",
    input: { reference: reference.describe("`reference` of a `hospital-visits` row."), ...hospitalRange },
    check: hospitalRule,
    run: (member, given) => member.records.fetchHospitalReportPdf(given.reference, given.as_of, range(given)),
  }),
];

const medication: Operation[] = [
  read({
    name: "prescriptions",
    category: kind_,
    summary: "List prescriptions.",
    description:
      "Filters apply to the fetched response. `renewable` means the portal shows the row as renewable; nothing is renewed. A purchase does not establish current use.",
    input: {
      status: z.enum(["all", "valid", "history", "purchased", "expired", "renewable"]).optional(),
      permanent: z.boolean().optional().describe("Keep only permanent (true) or non-permanent (false) prescriptions."),
    },
    rows: "data",
    run: (member, given) =>
      member.prescriptions.allPrescriptions(
        given.status === undefined && given.permanent === undefined
          ? undefined
          : {
              ...(given.status === undefined ? {} : { status: given.status }),
              ...(given.permanent === undefined ? {} : { permanent: given.permanent }),
            },
      ),
  }),
  document({
    name: "prescription-pdf",
    category: kind_,
    summary: "One prescription document.",
    description: "For digital prescriptions with `purchase_status` 1, 2 or 3.",
    input: { id: id.describe("`doc_id` of a `prescriptions` row.") },
    run: (member, given) => member.prescriptions.fetchPrescriptionPdf(given.id),
  }),
  read({
    name: "prescription-substitutes",
    category: kind_,
    summary: "The alternatives Maccabi lists for one prescription.",
    description: "Names and codes from the source, not advice to change treatment.",
    input: { id: id.describe("`doc_id` of a `prescriptions` row.") },
    rows: "data",
    run: (member, given) => member.prescriptions.allPrescriptionAlternatives(given.id),
  }),
  read({
    name: "pharmacy-purchases",
    category: kind_,
    summary: "Purchased-medication history, one upstream page at a time.",
    description: "`pagination.totalPages` in the result says how many pages exist.",
    input: { page: gridPage.optional().describe("Upstream page, 1 by default.") },
    run: (member, given) => member.records.allPurchasedMedicationHistory(given.page),
  }),
  document({
    name: "pharmacy-purchases-pdf",
    category: kind_,
    summary: "The purchased-medication report.",
    run: (member) => member.records.fetchMedicationReportPdf(),
  }),
  read({
    name: "referrals",
    category: kind_,
    summary: "Referrals written for the member, as this call returned them.",
    input: optionalDateRange,
    check: orderedRange,
    rows: "data",
    run: (member, given) => member.prescriptions.allReferrals(range(given)),
  }),
  document({
    name: "referral-pdf",
    category: kind_,
    summary: "One referral document.",
    input: { id: id.describe("`referral_id` of a `referrals` row.") },
    run: (member, given) => member.prescriptions.fetchReferralPdf(given.id),
  }),
];

const records: Operation[] = [
  read({
    name: "vaccine-groups",
    category: kind_,
    summary: "List vaccination groups with dose counts and dates.",
    description: "Not a claim of a complete immunization record.",
    rows: "data",
    run: (member) => member.records.allVaccinationGroups(),
  }),
  read({
    name: "vaccine-doses",
    category: kind_,
    summary: "The doses recorded in one vaccination group.",
    input: {
      group: z.number().int().min(0).describe("`vaccine_group_code` of a `vaccine-groups` row."),
    },
    rows: "data",
    run: (member, given) => member.records.fetchVaccinationDoses(given.group),
  }),
  document({
    name: "vaccine-certificate-pdf",
    category: kind_,
    summary: "The vaccination certificate.",
    run: (member) => member.records.fetchVaccinationCertificatePdf(),
  }),
  read({
    name: "sensitivities",
    category: kind_,
    summary: "List recorded sensitivities and intolerances.",
    description: "An empty list does not establish that the member has no allergies.",
    rows: "data",
    run: (member) => member.records.allSensitivities(),
  }),
  document({
    name: "sensitivities-pdf",
    category: kind_,
    summary: "The sensitivities report.",
    run: (member) => member.records.fetchSensitivityPdf(),
  }),
  read({
    name: "certificates",
    category: kind_,
    summary: "List medical certificates issued in a date range.",
    description: "Rows carry a `reference` for `certificate-pdf`.",
    input: dateRange,
    check: orderedRange,
    rows: "data",
    run: (member, given) => member.mailings.allCertificates({ from: given.from, to: given.to }),
  }),
  document({
    name: "certificate-pdf",
    category: kind_,
    summary: "One medical certificate.",
    description: "Pass the same range the row was listed with.",
    input: { reference: reference.describe("`reference` of a `certificates` row."), ...dateRange },
    check: orderedRange,
    run: (member, given) => member.mailings.fetchCertificatePdf(given.reference, { from: given.from, to: given.to }),
  }),
  read({
    name: "additional-information",
    category: kind_,
    summary: "List additional-information entries in a date range.",
    description: "PDF entries carry a `reference`. Video and link entries are listed but cannot be downloaded.",
    input: dateRange,
    check: orderedRange,
    rows: "data",
    run: (member, given) => member.mailings.allAdditionalInformation({ from: given.from, to: given.to }),
  }),
  document({
    name: "additional-information-pdf",
    category: kind_,
    summary: "One additional-information document.",
    description: "Pass the same range the row was listed with.",
    input: { reference: reference.describe("`reference` of an `additional-information` row."), ...dateRange },
    check: orderedRange,
    run: (member, given) =>
      member.mailings.fetchAdditionalInformationPdf(given.reference, { from: given.from, to: given.to }),
  }),
  read({
    name: "health-recommendations",
    category: kind_,
    summary: "Personal medical recommendations.",
    run: (member) => member.records.fetchRecommendations(),
  }),
  read({
    name: "medical-summary",
    category: kind_,
    summary: "The portal's selected summary of medications and laboratory data.",
    description: "A selection the portal shows, not a complete medical history.",
    run: (member) => member.records.fetchSelectedMedicalSummary(),
  }),
  document({
    name: "medical-summary-english-pdf",
    category: kind_,
    summary: "The English medical summary.",
    description: "Uses the account's existing details; nothing is updated.",
    run: (member) => member.records.fetchEnglishMedicalSummaryPdf(),
  }),
  read({
    name: "saved-documents",
    category: kind_,
    summary: "Documents the member saved to their medical file.",
    description: "Without a range, the year up to today, as the website does.",
    input: { ...optionalDateRange, page: gridPage.optional().describe("Upstream page, 1 by default.") },
    check: orderedRange,
    run: (member, given) => member.records.allSavedMedicalDocuments(range(given), given.page),
  }),
];

const inquiries: Operation[] = [
  read({
    name: "doctor-inquiries",
    category: kind_,
    summary: "List inquiries sent to doctors and clinics.",
    description:
      "Medical correspondence, not administrative requests (see `requests`). An `automatic_sick_permit` row carries its `pdf_reference` directly and has no detail.",
    rows: "data",
    run: (member) => member.requests.allInquiries(),
  }),
  read({
    name: "doctor-inquiry",
    category: kind_,
    summary: "Read one inquiry: both sides' remarks, forms, and the visit linked to it.",
    description:
      "Downloadable forms and linked visit documents carry a `pdf_reference`; a linked summary carries `summary_pdf_reference`.",
    input: { id: id.describe("`request_id` of a `doctor-inquiries` row.") },
    run: (member, given) => member.requests.fetchInquiry(given.id),
  }),
  document({
    name: "doctor-inquiry-pdf",
    category: kind_,
    summary: "One document of an inquiry or of its linked visit.",
    input: {
      id: id.describe("`request_id` of a `doctor-inquiries` row."),
      reference: reference.describe(
        "A `pdf_reference` or `summary_pdf_reference` from `doctor-inquiries` or `doctor-inquiry`.",
      ),
    },
    run: (member, given) => member.requests.fetchInquiryDocumentPdf(given.id, given.reference),
  }),
];

export const medical: Operation[] = [...labs, ...imaging, ...visits, ...medication, ...records, ...inquiries];
