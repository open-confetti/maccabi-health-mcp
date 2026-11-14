/**
 * Where maccabi.mjs sends a request none of its own routes took: the member's authorized users and
 * standing order, mailings and the three kinds of document behind them, sensitivities, the vaccination
 * certificate, the English summary, administrative requests with their attachments, the prescription
 * print and substitute drugs, the laboratory views (latest, followed, history) with their reports and
 * attached files, and the MedDream viewer behind its sign-in handoff.
 *
 * Field names, nesting and types follow docs/upstream.md. The values are all made up, and the file is
 * test scaffolding only. In the `imaging` scenario maccabi.mjs lists `imagingRows()` and gives the
 * member the checksum the viewer handoff is minted with; a test wanting any other answer overrides
 * the route.
 */
const site = (host) => `https://${host}.maccabi4u.co.il`;
const PORTAL = site("online");
const SIGN_IN = site("mac");
const VIEWER = site("meddreamy");
const OWNER = 40718293;

const api = (name, rest) => `/sonline/${name}API/webapi/mac/${rest}`;
const ownerApi = (name) => api(name, `v1/members/0/${OWNER}`);
const DIRECTORSHIP = ownerApi("Directorship");
const MEDICAL_FILE = ownerApi("MedicalFile");
const MAIN_APP = ownerApi("MainApp");
const REQUESTS = ownerApi("RequestsAndApprovals");
const TEST_RESULTS = ownerApi("TestResults");
const COMPARE = api("TestResults", `v1/compare/0/${OWNER}/compare`);

/** A PDF whose one comment line says which document a route served. */
const pdfText = (label) => ["%PDF-1.4", `% mock ${label}`, "%%EOF", ""].join("\n");
const pdfEnvelope = (label, extra = {}) => ({ ...extra, base64: Buffer.from(pdfText(label)).toString("base64") });

/**
 * The one study the viewer holds. The patient fields and the secrets of the handoff are here so a test
 * can name each of them and prove it never comes out of the tool.
 */
export const IMAGING = {
  study: "2.25.7391.31070000000206.5520000000.4000017",
  series: "2.25.7391.31070000000412.5520000000.6003",
  sop: "2.25.7391.31070000000618.5520000000.8005",
  secondary: "2.25.7391.31070000000618.5520000000.8006",
  storage: "pacs7Dicomweb",
  accession: "MOCKACCESSION01",
  patientName: "MOCKSCANNEDPERSON",
  patientId: "MOCKSCANNEDID31",
  birthDate: "20000101",
  clinicianId: "MOCKPHYSICIANCODE",
  checksum: "5C19E07A42D683BF5C19E07A42D683BF",
  handoff: "mock.viewer.jwe.one.two",
  assertion: "bW9jay1hc3NlcnRpb24=",
  nonce: "7be1c05d92f64a38a1c05d92f64a387b",
  his: "MOCKVIEWERHIS93e7",
  csrf: "MOCKVIEWERCSRF58b0",
  // The viewer host's F5 session before and after its second leg, then MedDream's own before and after /his.
  cookies: {
    f5Pending: "1f".repeat(16),
    f5: "2e".repeat(16),
    appAnonymous: "3d".repeat(16),
    app: "4c".repeat(16),
  },
};
const SCAN = { description: "MOCK STUDY", day: "2001-01-01", sex: "O", rows: 5, columns: 7 };
/** UIDs the DICOM standard itself assigns: transfer syntaxes and SOP classes. */
const dicom = (suffix) => `1.2.840.10008.${suffix}`;
const instance = (sopInstanceUID, sopClass) => ({
  sopInstanceUID,
  sopClassUID: dicom(sopClass),
  transferSyntaxUID: dicom("1.2.4.50"),
  // Live, the structure reports no frames for an instance whose metadata reports one.
  numberOfFrames: 0,
});
const STRUCTURE = {
  storageId: IMAGING.storage,
  studyInstanceUID: IMAGING.study,
  studyDescription: SCAN.description,
  studyDate: SCAN.day,
  studyTime: "12:00:00",
  mainModality: "US",
  sourceApplicationEntityTitle: "",
  reportIsAvailable: false,
  hasReport: false,
  patientID: IMAGING.patientId,
  patientName: IMAGING.patientName,
  patientSex: SCAN.sex,
  patientBirthDate: "2000-01-01",
  series: [
    {
      modality: "US",
      seriesDescription: "MOCK SERIES",
      seriesInstanceUID: IMAGING.series,
      instances: [instance(IMAGING.sop, "5.1.4.1.1.3.1"), instance(IMAGING.secondary, "5.1.4.1.1.7.2")],
    },
  ],
};
/** What the viewer says about one image: a tiny 8-bit monochrome frame, where a real one is megabytes. */
const metadata = (sopInstanceUID) => ({
  studyInstanceUID: IMAGING.study,
  seriesInstanceUID: IMAGING.series,
  sopInstanceUID,
  sopClassUID: dicom("5.1.4.1.1.3.1"),
  transferSyntaxUID: dicom("1.2"),
  modality: "US",
  imageType: "ORIGINAL\\PRIMARY",
  accessionNumber: IMAGING.accession,
  patientID: IMAGING.patientId,
  studyDate: SCAN.day.replaceAll("-", ""),
  studyTime: "120000",
  seriesNumber: 2,
  instanceNumber: 3,
  rows: SCAN.rows,
  columns: SCAN.columns,
  numberOfFrames: 1,
  samplesPerPixel: 1,
  photometricInterpretation: "MONOCHROME2",
  pixelRepresentation: 0,
  bitsStored: 8,
  bitsAllocated: 8,
  maxPixelValue: 255,
  windowWidth: [240],
  windowCenter: [120],
  pixelAspectRatio: { x: 1, y: 1 },
  lossyCompressionMethod: "NOT_LOSSY",
  suvBwScaleFactor: 0,
  imageOrientationPatient: [0, 0, 0, 0, 0, 0],
  imagePositionPatient: [0, 0, 0],
  sequenceOfUltrasoundRegions: [
    {
      regionDataType: 2,
      regionSpatialFormat: 1,
      transducerFrequency: 3500,
      physicalDeltaX: 0.0123,
      physicalDeltaY: 0.0123,
    },
  ],
  // The labels the viewer draws over the picture repeat the patient's name.
  viewPortLabels: {
    right: [SCAN.description, SCAN.day, "SERIES 2", "IMAGE 3"],
    left: [IMAGING.accession, IMAGING.patientName],
  },
  attributes: {
    // Equipment and study tags, which describe the scan.
    "00080070": "SPECIMEN IMAGING LTD",
    "00080080": "SPECIMEN IMAGING CENTRE",
    "00080090": "REFERRER^SPECIMEN",
    "00081010": "SUITE-B",
    "00081090": "MOCK-MODEL",
    "00181000": "MOCK-SERIAL-0000",
    "00200010": IMAGING.accession,
    "00280002": "1",
    // Group 0010, which describes the patient.
    "00100010": IMAGING.patientName,
    "00100030": IMAGING.birthDate,
    "00100040": SCAN.sex,
    // Identification-code sequences: a clinician's national id can sit in any of them.
    "00080096": [{ "00401101": IMAGING.clinicianId }],
    "00081062": IMAGING.clinicianId,
    "00321031": IMAGING.clinicianId,
    "0040A07C": IMAGING.clinicianId,
    // Keys that are not tags at all: one names the patient, one is harmless.
    PatientName: IMAGING.patientName,
    note: "הערה מדומה לסריקה",
  },
});
/** The shortest thing that starts and ends like a JPEG. */
const THUMBNAIL = Buffer.from("ffd8ffdb00430001ffd9", "hex");
const hiddenInput = (name, value) => `<input type="hidden" name="${name}" value="${value}">`;
const SAML_PAGE = [
  `<html><body onload="document.forms[0].submit()">`,
  `<form id="frmRedirect" method="post" action="${VIEWER}/saml/sp/profile/post/acs">`,
  hiddenInput("SAMLResponse", IMAGING.assertion),
  hiddenInput("RelayState", ""),
  `<input type="Submit" value="continue"></form></body></html>`,
].join("");
const POLICY_PAGE = [
  `<html><body><form action="/saml/sp/profile/post/acs" method="POST">`,
  `<input name="dummy" value="${IMAGING.nonce}"><input name="state" value="q1w2e3r4">`,
  "</form></body></html>",
].join("");

/** One imaging row of the test list, in the 28-key shape of the laboratory row in maccabi.mjs. */
const scanRow = (type, request_id, doc_id, doc_type_name, test_name, result_files) => ({
  type,
  request_id,
  doc_id,
  doc_type_name,
  doc_type_id: 4,
  test_name: [test_name],
  test_category: [],
  result_files,
  category_name: "דימות",
  category_id: 3,
  category_original_id: 3,
  data_type_code: 3,
  member_id_code: 0,
  member_id: String(OWNER),
  execute_date: `${SCAN.day}T12:00:00`,
  result_date: "2001-01-02T00:00:00",
  result_date_desc: "01.01.2001",
  time_stamp: "scan-stamp-3",
  hash: "mock%2Fscan%2Bsig%3D",
  concealment: "0",
  is_read: false,
  is_partial: false,
  is_result_yesterday: false,
  file_name: null,
  procedures: null,
  executed_by: null,
  referrer_name: null,
  executing_institute: null,
});
/** The study the viewer opens, and a written result that attaches a document. */
export const imagingRows = () => [
  scanRow("imaging_study", IMAGING.study, "scan-study-doc", "בדיקת דימות", "בדיקת דימות מדומה", null),
  scanRow("imaging_result", "scan-req-8", "scan-doc-8", "תשובת דימות", "תשובה כתובה", [
    { result_file: "mock/scan/report-file" },
  ]),
];

/** An analyte as the latest, followed and history views carry it: a made-up one, above its range, followed. */
const analyte = (changes = {}) => ({
  test_id: "mock-analyte-a",
  test_desc: "Mock Analyte A",
  lab_date: "2001-03-01",
  result: 200,
  units: "unit",
  max_lim: 100,
  min_lim: 0,
  numeric_percentage: 90,
  is_follow: true,
  is_vitek: false,
  vitek_row: [],
  is_messages: "1",
  message_list: ["מעל הטווח"],
  message: "",
  hash: null,
  time_stamp: null,
  result_file: null,
  ...changes,
});
/** A second made-up analyte, within its range, with a file attached. */
const ANALYTE_WITH_FILE = analyte({
  test_desc: "Mock Analyte B",
  test_id: "mock-analyte-b",
  result: 50,
  max_lim: 90,
  min_lim: 10,
  is_follow: false,
  message_list: [],
  hash: "analytebsig",
  time_stamp: "analytebstamp",
  result_file: "%2Fmock%2Fanalyte-b-file.pdf",
});
const historyPoint = (lab_date, result) => ({
  ...analyte({ lab_date, result }),
  is_graph: true,
  doc_last_name: "רופאה",
  doc_first_name: "מדומה",
});

const AUTHORIZED_USERS = {
  messages: [{ message: "אישור מדומה", type: "S-Success" }],
  users: [
    {
      user_id: "0042",
      last_name: "מדומה",
      first_name: "נציג",
      patient_relation_id: "MOCKRELATION19",
      user_technical_id: "MOCKTECHNICAL07",
      authentication_end_date: "2031-06-30",
    },
  ],
};
const STANDING_ORDER = {
  token: "MOCKDEBITTOKEN",
  account_number: 99999999,
  branch_name: "סניף מדומה",
  branch_code: 999,
  bank_name: "בנק מדומה",
  bank_code: 99,
  payer_type: 1,
  payment_method: 2,
  auth_start_date: "2001-01-01",
  is_active_auth_exists: true,
  is_shaban_auth_only: false,
  is_credit_auth_only: false,
  last_four_digits_credit_card: "",
  credit_card_type: "",
};
const dated = (day) => ({ member_id_code: "0", member_id: OWNER, original_item_date: day, item_date: day });
/** One mailing of each kind: a letter, a record the member asked for, and treatment guidance. */
const MAILINGS = [
  {
    ...dated("2026-06-09"),
    letter_type: 1,
    letter_desc: "מכתב מדומה",
    child_info: false,
    recipient_id_code: "0",
    recipient_id: OWNER,
    is_doc_exist: "1",
    mailing_type: "1",
    // portal.mjs serves this letter's document under these two ids.
    name_document: "post-doc-9",
    reference_id: "post-ref-9",
    hash: "letter%2Bsignature",
    timestamp: "letter-stamp-7",
  },
  {
    ...dated("2026-06-12"),
    letter_type: 2,
    status: 1,
    hash: "recordsig4",
    timestamp: "recordstamp4",
    link: "%2Fmock%2Frequested-record.pdf",
  },
  {
    ...dated("2026-06-18"),
    letter_type: 3,
    practitioner_name: "מטפלת מדומה",
    service_type_text: "שירות מדומה",
    tutorials: [
      {
        display_text: "עלון תרגילים",
        tutorial_type: "pdf",
        hash: "sheetsig9",
        timestamp: "sheetstamp9",
        url: "%2Fmock%2Fexercise-sheet.pdf",
      },
      {
        display_text: "קריאה נוספת",
        tutorial_type: "webpage",
        url: "https://www.maccabi4u.co.il/healthguide/mock-article",
      },
    ],
  },
];
const SENSITIVITIES = {
  intolerance: [
    {
      sensitivity: "רגישות מדומה",
      classification: "סיווג מדומה",
      sensitivity_presentation: "תגובה מדומה",
      speciality: "מקצוע מדומה",
      practitioner_name: null,
      registration_date: "2001-01-01",
      hash: "MOCKSENSITIVITYSIG",
    },
  ],
};

const CASE = "case-7301";
const SERVICE_REQUEST = "sr-5120";
/** A document row: its title or file name, then a private path with the signature that opens it. */
const signedFile = (named, stem) => ({
  ...named,
  uri: `%2Fmock%2F${stem}.pdf`,
  hash: `${stem}-sig`,
  timestamp: `${stem}-stamp`,
});
const TIMELINE = [
  {
    interaction_id: CASE,
    classification: "Case",
    member_id_code: 0,
    member_id: String(OWNER),
    status: "בטיפול",
    type_name: "בקשת החזר",
    status_update_date: "2026-05-20",
    is_read: false,
    has_content: true,
    expand_data: { token: "MOCKEXPANDTOKEN" },
    obligation_provider_name: null,
  },
  {
    interaction_id: SERVICE_REQUEST,
    classification: "ServiceRequest",
    member_id_code: 0,
    member_id: String(OWNER),
    status: "נסגרה",
    type_name: "פנייה",
    status_update_date: "2026-05-27",
    is_read: true,
    has_content: true,
  },
];
/** A case of type 75 with documents from Maccabi: the kind whose own documents the portal shows behind a switch. */
const CASE_DETAIL = {
  interaction_id: CASE,
  member_id_code: "0",
  member_id: String(OWNER),
  unified_status_code: 51,
  case_type_code: 75,
  treatment_date: "2026-04-14",
  has_documents_from_maccabi: true,
  documents: [signedFile({ title: "כתב התחייבות" }, "case-undertaking")],
  messages: [
    {
      from_maccabi: true,
      body: "מענה מדומה",
      created_on: "2026-05-20",
      documents: [signedFile({ file_name: "מענה חתום" }, "case-reply")],
    },
  ],
  extended_properties: {
    obligation_details: {
      service_provider: { service_provider_name: "ספק מדומה" },
      department: { department_description: "מחלקה מדומה" },
      treatment_array: [{ treatment_name: "טיפול מדומה", health_ministry_code: "K4" }],
      doctor_referral: { doctor_referral_name: "הפניה מדומה", doctor_referral_code: 23 },
    },
  },
};
const SERVICE_REQUEST_DETAIL = {
  interaction_id: SERVICE_REQUEST,
  member_id: String(OWNER),
  documents: [signedFile({ file_name: "נספח" }, "request-annex")],
  body: "פנייה מדומה",
};

/** Answers a route only when it was posted to, as the portal does for its list queries. */
const posted = (answer) => (ask, to) => (ask.method === "POST" ? answer(ask, to) : null);
const sendJson = (payload) => (_ask, to) => to.json(payload);
const sendPdf = (label) => (_ask, to) => to.pdf(label);

/** The portal's routes by path. A handler gets the request and the ways to answer it. */
const PORTAL_ROUTES = new Map([
  [`${DIRECTORSHIP}/accounts`, sendJson(AUTHORIZED_USERS)],
  [api("Directorship", `v1/payers/0/${OWNER}/debit_authorization`), sendJson(STANDING_ORDER)],

  [`${DIRECTORSHIP}/all/letters_for_member`, posted(sendJson({ letters: MAILINGS }))],
  [`${MAIN_APP}/pdf`, sendPdf("requested-record")],
  [`${MAIN_APP}/pdf/http`, sendPdf("mailing-guide")],
  [api("MainApp", `v2/members/0/${OWNER}/pdf`), sendPdf("requested-record-blob")],

  [`${MEDICAL_FILE}/sensitivity`, sendJson(SENSITIVITIES)],
  [`${MEDICAL_FILE}/sensitivity/pdf`, sendJson(pdfEnvelope("sensitivities-report"))],
  [
    `${MEDICAL_FILE}/vaccination/certificates/report`,
    sendJson(pdfEnvelope("certificate-of-vaccination", { type: "pdf" })),
  ],
  [`${DIRECTORSHIP}/timestampAndHash`, sendJson({ hash: "summary%2Fsig%3D%3D", timestamp: "summarystamp" })],
  [`${DIRECTORSHIP}/report/english/`, sendPdf("summary-in-english")],

  [`${REQUESTS}/requests_and_cases`, posted(sendJson(TIMELINE))],
  [`${REQUESTS}/cases/${CASE}`, sendJson(CASE_DETAIL)],
  [`${REQUESTS}/service_requests/${SERVICE_REQUEST}`, sendJson(SERVICE_REQUEST_DETAIL)],
  [`${REQUESTS}/service_requests_document`, sendPdf("request-attachment")],

  [`${MEDICAL_FILE}/getprescriptionpdf`, sendPdf("prescription-print")],
  [
    `${MEDICAL_FILE}/alternativeDrugs`,
    sendJson({
      drugs: [
        { name: "תחליף מדומה", largo_code: "1000" },
        { name: "תחליף שני", largo_code: 2000 },
      ],
    }),
  ],

  [
    `${TEST_RESULTS}/getlatestlabresults`,
    sendJson({
      // catalog.test.ts expects the latest report to be signed with exactly this pair.
      hash: "latest%2Bhash",
      time_stamp: "newesttime",
      results: [{ group_values: [analyte(), ANALYTE_WITH_FILE], group_name: "ביוכימיה" }],
    }),
  ],
  [`${TEST_RESULTS}/getlatestlabresults/report`, sendPdf("latest-report")],
  [
    `${TEST_RESULTS}/followed`,
    sendJson({
      hash: "followsig",
      timestamp: "followstamp",
      options: [{ is_follow: true, test_desc: "Mock Analyte A", test_id: "mock-analyte-a" }],
      followed_tests: [analyte()],
      followed_counter: 1,
    }),
  ],
  [`${TEST_RESULTS}/followed/report`, sendPdf("tracked-summary")],
  [`${TEST_RESULTS}/getresultsbyid/report`, sendPdf("lab-report")],
  [`${TEST_RESULTS}/labs/corona/Report`, sendPdf("covid-report-in-english")],
  [
    COMPARE,
    (ask, to) =>
      to.json({
        hash: "compare%2Bsig",
        timestamp: "comparestamp",
        other_results: [historyPoint("2001-01-01", 100)],
        current_result: historyPoint(ask.query.get("date_of_result"), 200),
      }),
  ],
  [`${COMPARE}/report`, (ask, to) => to.pdf(ask.query.get("is_graph") === "true" ? "history-graph" : "history-table")],
  [api("TestResults", "pdf/showresult"), sendPdf("analyte-file")],
  [api("TestResults", "pdf/openfile"), (ask, to) => to.pdf(`original-of-${ask.query.get("data")}`)],

  // The first hop of the viewer handoff: minted for the listed study, with the member's own checksum.
  [
    api("TestResults", `pdf/members/0/${OWNER}/meddream/token/${IMAGING.study}`),
    (ask, to) =>
      ask.query.get("checksum") === IMAGING.checksum
        ? to.redirect(`${SIGN_IN}/imaging/login?token=${IMAGING.handoff}`)
        : null,
  ],
]);

/** The fake's answer to one request, or null when the request is none of this file's. */
export function records(url, method, body, { respond, json, log }) {
  const send = (content, type, headers = {}) => respond(url.href, content, 200, { "content-type": type, ...headers });
  const to = {
    send,
    json: (payload) => json(url.href, payload),
    pdf: (label) => send(pdfText(label), "application/pdf"),
    redirect: (location, ...cookies) =>
      respond(url.href, null, 302, [["location", location], ...cookies.map((cookie) => ["set-cookie", cookie])]),
  };
  if (url.origin === VIEWER || (url.origin === SIGN_IN && url.pathname === "/imaging/login")) {
    log({ kind: "viewer", method, path: url.pathname });
    return viewer(url, method, body, to);
  }
  if (url.origin !== PORTAL) return null;
  const answer = PORTAL_ROUTES.get(url.pathname);
  return answer ? answer({ method, query: url.searchParams }, to) : null;
}

/** Hops two to eight of the handoff, then the study tree and the reads of one image. */
function viewer(url, method, body, to) {
  const { cookies } = IMAGING;
  const token = url.searchParams.get("token");
  const page = (markup, headers) => to.send(markup, "text/html;charset=UTF-8", headers);
  switch (url.pathname) {
    case "/imaging/login":
      return token === IMAGING.handoff ? page(SAML_PAGE) : null;
    case "/saml/sp/profile/post/acs":
      if (method !== "POST") return null;
      // Posted to twice: first with the SAML assertion, then with the nonce of the policy page.
      if (!new URLSearchParams(String(body)).has("SAMLResponse"))
        return to.redirect("/", `MRHSession=${cookies.f5}; path=/; secure`);
      return to.redirect(
        "/my.policy",
        `MRHSession=${cookies.f5Pending}; path=/; secure`,
        "LastMRH_Session=1f1f1f1f; path=/; secure",
      );
    case "/my.policy":
      return page(POLICY_PAGE);
    case "/":
      if (token === null) return to.redirect(`/?token=${IMAGING.his}`);
      return page("<html><body>viewer shell</body></html>", {
        "set-cookie": `MEDDREAMSESSID=${cookies.appAnonymous}; Path=/; HttpOnly`,
        "x-csrf-token": IMAGING.csrf,
      });
    case "/his": {
      if (token !== IMAGING.his) return null;
      const granted = { studyIds: [{ modality: "US", storageId: IMAGING.storage, studyUid: IMAGING.study }] };
      return to.send(JSON.stringify(granted), "application/json;charset=UTF-8", {
        "set-cookie": `MEDDREAMSESSID=${cookies.app}; Path=/; HttpOnly`,
      });
    }
    case `/studies/${IMAGING.study}/structure`:
      return to.json(STRUCTURE);
    default:
      return image(url.pathname, to);
  }
}

/** One image of the series: its metadata, its thumbnail or its raw pixels. */
function image(path, to) {
  const images = `/studies/${IMAGING.study}/series/${IMAGING.series}/images/`;
  if (!path.startsWith(images)) return null;
  const [sop, part, ...deeper] = path.slice(images.length).split("/");
  if (deeper.length > 0 || ![IMAGING.sop, IMAGING.secondary].includes(sop)) return null;
  switch (part) {
    case "metadata":
      return to.json(metadata(sop));
    case "thumbnail":
      return to.send(THUMBNAIL, "image/jpeg;charset=UTF-8");
    case "pixels":
      return to.send(new Uint8Array(SCAN.rows * SCAN.columns).fill(0x2a), "application/octet-stream;charset=UTF-8");
    default:
      return null;
  }
}
