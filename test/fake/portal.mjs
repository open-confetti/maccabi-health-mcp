/**
 * The fake Maccabi's side of the generic catalog reads: what `portal` and `portal-document` are answered
 * on each path this suite asks for. Keys, nesting and value types follow Maccabi's answers as
 * docs/upstream.md describes them; the values are made up. maccabi.mjs looks a request's path up in the
 * three exported tables, and takes the second inquiry from here as well.
 */
const OWNER = 40718293;
const ME = `0/${OWNER}`;
/** Somebody else on the account (a payer, a relative). A result must never show this number. */
const RELATIVE = 31415926;
/** Identity values of the owner that no result may carry. */
const CHECKSUM = "MOCKMEMBERSUM63";
const TRAVEL_DOCUMENT = "MOCKTRAVELDOC18";
const TECHNICAL_ID = "MOCKTECHREF52";

const mac = (service) => `/sonline/${service}/webapi/mac`;
/** Where one service keeps the owner's own resources. */
const mine = (service, version = "v1") => `${mac(service)}/${version}/members/${ME}`;
/** `table` with every key moved under `base`. */
const under = (base, table) =>
  Object.fromEntries(Object.entries(table).map(([tail, value]) => [`${base}/${tail}`, value]));

/**
 * Maccabi signs a document row afresh in every answer, so two listings of one letter never agree on
 * its signature. A reference that still opens the document after a second listing was therefore not
 * derived from it. The process id in the pair keeps two runs of the CLI apart as well. Letters carry
 * the pair percent-encoded; the other rows carry it ready to send on.
 */
let issued = 0;
function signature(form = "plain") {
  issued += 1;
  const serial = `${process.pid}n${issued}`;
  return form === "encoded"
    ? { hash: `sig%2F${serial}`, timestamp: `issued-at-${serial}` }
    : { hash: `sig${serial}`, timestamp: `at${serial}` };
}

const DOCTOR = 'ד"ר פלונית בדויה';
const SECOND_DOCTOR = 'ד"ר אלמוני נוסף';
/** One doctor's three numbers, the same wherever a row names her. */
const STAFF = { employee: 1001, position: 2002, practitioner: 3003 };

/** The `basic_data` block every level of the notification settings repeats. */
const setting = (item_code, name, description = "") => ({
  order: "1",
  restriction_desc: "",
  restriction_code: null,
  can_register: true,
  is_registered: true,
  description,
  name,
  item_code,
});

const directorship = {
  entitlement: {
    is_all_in_my_maccabi: false,
    next_month_date: "2027-03-01",
    members: [
      {
        age: null,
        last_name: null,
        first_name: null,
        payer_id: String(RELATIVE),
        payer_id_code: "0",
        treatment_code: "4",
        eligibility_status: "2",
        existing_insurance: "07",
        relationship: "הורה",
        member_id: String(OWNER),
        member_id_code: "0",
      },
    ],
  },
  payer_billing_subjects: {
    payer_billing_subjects: [
      {
        member_status: "חבר פעיל",
        member_last_name: "אלמוני",
        member_first_name: "פלוני",
        member_id_code: "0",
        member_id: OWNER,
        status_in_family: "ראש משפחה",
        primary_id_code: "0",
        primary_id: RELATIVE,
      },
    ],
  },
  // A member who is not enrolled gets no content.
  biobank: null,
  letters_for_member: () => ({
    letters: [
      {
        letter_type: 2,
        ...signature("encoded"),
        original_item_date: "2026-03-17",
        item_date: "2026-03-17",
        member_id_code: "0",
        member_id: OWNER,
        is_personal_mail: "0",
        name_document: "mail-doc-7",
        code_type_document: 6,
        code_sub_system: "Q",
        code_system: "M",
        // The website's preview link names the member checksum, which is why it is never returned.
        preview_url: `/sonline/DirectorshipAPI/preview?checksum=${CHECKSUM}`,
        reference_id: "mail-ref-7",
        recipient_id_code: "0",
        recipient_id: OWNER,
        is_doc_exist: "1",
        mailing_type: "2",
        child_info: false,
        letter_desc: "הודעה מומצאת",
        letter_code: 58,
        recipient_l_name: "אלמוני",
        recipient_f_name: "פלוני",
      },
    ],
  }),
  online_notification: {
    status_code: 0,
    contact_details: { email: "nobody@example.invalid", cell_phone: "050-0000000" },
    groups: [
      {
        services: [
          {
            channels: [{ basic_data: setting(2, "דואר אלקטרוני") }],
            registration_type: 2,
            default_channel_code: 2,
            type_code: null,
            basic_data: setting(34, "תוצאה חדשה"),
          },
        ],
        basic_data: setting(3, "בדיקות", "עדכון על תוצאות בדיקה"),
      },
    ],
    push_info: { recipients: null, is_push_registered: false },
    is_signed: "0",
    preferred_lang_code: 1,
  },
  "insurance/seniority": () => ({
    ...signature(),
    insurance_groups: [{ ins_status: "1", ins_seniority_date: "2001-01-01", ins_type_code: "07" }],
    membership_end_date: "2098-12-31",
    membership_status: 1,
  }),
  // medical-file.test.ts reads these three amounts through `billing-totals`.
  "finance/debts": { additional_charges_debt: 0, shaban_debt: 12.5, kupa_debt: 0 },
  "debts/details": { debts: [], total_debt: 0 },
};

/** DirectorshipAPI paths that do not start at the member. */
const directorshipElsewhere = {
  // Public enrollment figures: neither the path nor the answer names anyone.
  "v1/biobank/stats": { updated_on: "2001-01-01T00:00:00", total_enrolled: 10000 },
  [`v1/payers/${ME}/debts/details`]: { messages: null, payees: null, payer_debt: 0 },
  [`v2/payers/${ME}/debts/details`]: {
    family_cell: null,
    is_eligible_to_pay: false,
    payer_hvr_debt: 0,
    payer_kupa_debt: 0,
  },
  [`oncogenetic/${ME}/oncogenetic/eligibility`]: { oncogenetic_form_found: false },
  eligibilities: {
    subjects: [
      {
        services: [
          {
            service_name: "החזר על משקפי ראייה",
            service_type: "T",
            service_enum: "5",
            service_code: 8120,
            subject_id: 37,
          },
        ],
        subject_name: "אופטיקה",
        subject_id: 37,
      },
    ],
  },
  [`eligibilities/${ME}/member_service_history`]: {
    _data: [{ quantity: 2, provider_name: "מכון אופטיקה בדוי", service_date: "2001-01-01" }],
  },
  [`eligibilities/${ME}/member_service_rights`]: {
    deductible: { show_deductible: false },
    refund2: { show_refund2: false },
    refund: { min_participation: 0, show_refund: false },
    utilization: { total: 8, used: 3, show_utilization: true },
    eligibility_status: true,
  },
};

const mainApp = {
  features: [
    { feature_enabled: true, feature_id: "IshurMakdim" },
    { feature_enabled: false, feature_id: "isOpenPdfByLinkHandlerV2" },
  ],
  "patient/approvals/10": { update_date: null, patient_approval_id: "0" },
};

/** The member record of MainAppAPI v2, identity fields and all. */
const memberDetails = {
  phones: [{ phone_no: 0, phone_prefix: "050", phone_type: "נ" }],
  id_tech: TECHNICAL_ID,
  passport_number: TRAVEL_DOCUMENT,
  member_maccabi_status: 1,
  pays_buy_services_code: 2,
  pays_id: RELATIVE,
  is_charge_allowed: 0,
  is_status404_and_mac_status1_received: false,
  is_parent: true,
  checksum_id: CHECKSUM,
  status_reason: 0,
  status_membership: 1,
  language_code: 2,
  unifier_id: RELATIVE,
  buy_services_organization_code: 2,
  membership_status_cause: 0,
  birth_date: "2000-01-01T00:00:00",
  member_id: OWNER,
  member_id_code: null,
};

/** The home page's feed; its path carries the birth date and age of the bootstrap in maccabi.mjs. */
const homePage = {
  "2000-01-01/26/get_notification_and_updates": {
    notification_and_updates: [
      {
        data_type_code: null,
        last_date: "2001-01-01",
        is_read: true,
        concealment: "0",
        member_id_code: 0,
        member_id: String(OWNER),
        doc_type_name: "הפניה לבדיקה",
        doc_type_id: 9,
        timestamp_sequence: "000001",
        identification_method: 2,
        has_summery_file: false,
        is_advertised: true,
        pernr: STAFF.employee,
        object_id: 1000,
        object_type: "S",
        service_name: "מקצוע מדומה",
        service_provider_name: "בדויה",
        service_provider_title: "פרופ'",
        appointment_date: "2001-01-01T12:00:00",
        appointment_id: "visit-1",
        $type: 1,
      },
    ],
  },
};

const medicalFile = {
  applications: () => ({
    results: [
      {
        ...signature(),
        clinic_name: "מרפאה בדויה",
        submit_date: "2026-04-21",
        status: "בבדיקה",
        form_name: "טופס הצהרת בריאות",
        archive_form_id: 15,
        form_id: 7260,
      },
    ],
    error: false,
    no_results: false,
  }),
  assigned_practitioners: [
    {
      clinic_address: "שדרות הבדיון 12, קרית דוגמה",
      profession_areas: [{ code: "4" }],
      concealment: ["0"],
      clinic_assign_status_desc: "שיוך קבוע",
      clinic_assign_status_code: 2,
      clinic_assign_status: true,
      practitioner_name: DOCTOR,
      practitioner_id: STAFF.practitioner,
      position_id: STAFF.position,
      employee_id: STAFF.employee,
      gender: "M",
    },
  ],
  // The dedicated `health-recommendations` read falls back to the legacy page on this null.
  personal_recommendations: { recommendations: null },
  "child_development/diagnosis_summary": [],
  "child_development/forms": { form_response: null, no_forms: true },
  // Group 5 with two doses, and the dose below, are what medical-file.test.ts reads through `vaccine-groups`.
  // The second group has one of the website's COVID codes, the only groups it prints a record for.
  // The names and dates are made up.
  vaccinations_grouped: () => ({
    timeline: [
      {
        ...signature(),
        last_date: "2001-02-01",
        first_date: "2001-01-01",
        vaccine_group_name: "קבוצת חיסון מדומה",
        vaccinations_amount: 2,
        vaccine_group_code: 5,
      },
      {
        ...signature(),
        last_date: "2001-04-01",
        first_date: "2001-03-01",
        vaccine_group_name: "קבוצת חיסון שנייה",
        vaccinations_amount: 3,
        vaccine_group_code: 95884,
      },
    ],
    ...signature("encoded"),
  }),
  vaccinations: [
    {
      source: "1",
      remark: null,
      age_on_vaccination: "1",
      vaccination_place: "מרפאה בדוי",
      vaccination_date: "2001-02-01",
    },
  ],
  "prescriptions/purchased/report": {
    base64: Buffer.from(["%PDF-1.7", "% mock purchased-report", "%%EOF", ""].join("\n")).toString("base64"),
    type: "pdf",
  },
  // A member with no tutorials.
  tutorials: { tutorials: [] },
};

const appointmentOrder = {
  "eligibility/vaccines/flu": { need_fluzone: true, is_vaccine_eligable: true, target_population_ind: false },
  eligibility_for_corona_test: { eligibility_ind: 1 },
  "vaccines/corona/eligibilities": { vaccine_completed: 0, corona_disease_status: 1, eligibility_ind: 0 },
  "files/uploaded": {
    events: [
      {
        files: [
          {
            upload_date: "2026-05-30",
            original_description: "סריקת הפניה",
            description: "סריקת הפניה",
            file_id: "upload-22",
          },
        ],
        event_id: "event-40",
      },
    ],
  },
  // The second inquiry points at this open medical record, which has no visit behind it: the portal answers 204.
  "visits/omr-1/": null,
};

/** The website reads a swap registration only by its id; see PORTAL_STATUS for the list path. */
const appointmentOrderV2 = {
  "appointments/switchit-registrations/swap-52": {
    to_date: "2027-01-28",
    from_date: "2027-01-12",
    status: 2,
    appointment_id: "booking-18",
    registration_id: "swap-52",
  },
};

const doctorRequests = {
  // maccabi.mjs counts two earlier requests for service code 10 and one for any other.
  "inquiries/service_providers": {
    connected_doctors: [{ doctor_name: SECOND_DOCTOR, specialization_code: 6, service_code: 27 }],
    family_doctors: [{ doctor_name: DOCTOR, specialization_code: 3, service_code: 10 }],
  },
  "read_status/counters": { read_status_counters: [] },
};

const requestsAndApprovals = {
  topics: [
    {
      subtopic_array: [
        {
          is_active: true,
          sorting: 2,
          crm_code: 46,
          is_display_minor_disclaimer: true,
          // A portal link with its token: private, and handed to the member's browser as it is.
          eligibility_link: "/sonline/private/refund-form?token=MOCKFORMTOKEN",
          required_document: "חשבונית מקורית",
          name: "טיפולי שיניים",
          code: 62,
        },
      ],
      is_active: true,
      sorting: 3,
      crm_code: 40,
      is_display_minor_disclaimer: false,
      eligibility_link: "https://www.maccabi4u.co.il/new/eligibilites/6/",
      required_document: "",
      name: "בקשות להחזר כספי",
      code: 6,
    },
  ],
  "pending/referrals": null,
};

const testResults = {
  "followed/testlist": [],
  "followed/options": [{ is_follow: false, test_desc: "Mock Analyte C", test_id: "mock-analyte-c" }],
  "followed/counter": { followed_counter: 0 },
};

/** Whether the member may change her assigned doctor: she already has one. */
const assignmentEligibility = {
  permanent_ascription_indication: null,
  future_appointment_date: null,
  total_future_appointments: null,
  has_future_appointment: false,
  last_visit_date: "2001-01-01",
  visited_this_qtr: false,
  practitioner_full_name: DOCTOR,
  as400_role: "R",
  facility_code: 9000,
  practitioner_id: STAFF.practitioner,
  position_id: STAFF.position,
  employee_number: STAFF.employee,
  is_assign_active: true,
  abroad_remark_code: null,
  is_customer_abroad: null,
  is_customer_active: true,
  next_possible_assign_date: "2030-01-01",
  description: "קיים שיוך פעיל",
  code: 5,
  is_eligible: false,
};

/** Only an answer that is signed afresh on every call is written as a function above; the rest are plain values. */
const asFunction = (answer) => (typeof answer === "function" ? answer : () => answer);

/**
 * JSON answers by request path. Each entry is called with the request URL and returns the body, or
 * null for an HTTP 204.
 */
export const PORTAL_JSON = Object.fromEntries(
  Object.entries({
    ...under(mine("DirectorshipAPI"), directorship),
    ...under(mac("DirectorshipAPI"), directorshipElsewhere),
    ...under(mine("MainAppAPI"), mainApp),
    [mine("MainAppAPI", "v2")]: memberDetails,
    ...under(mine("HomePageAPI"), homePage),
    ...under(mine("MedicalFileAPI"), medicalFile),
    [`${mac("MedicalFileAPI")}/v1/practitioner_affiliation/${ME}/eligibilities`]: assignmentEligibility,
    ...under(mine("AppointmentOrderAPI"), appointmentOrder),
    ...under(mine("AppointmentOrderAPI", "v2"), appointmentOrderV2),
    ...under(mine("CommunicationWithDoctorAPI"), doctorRequests),
    ...under(mine("RequestsAndApprovalsAPI"), requestsAndApprovals),
    ...under(mine("TestResultsAPI"), testResults),
  }).map(([path, answer]) => [path, asFunction(answer)]),
);

/** Paths that answer with a bare HTTP status. The portal answers a listing of swap registrations with a 405. */
export const PORTAL_STATUS = under(mine("AppointmentOrderAPI", "v2"), {
  "appointments/switchit-registrations/": 405,
});

/** Document paths, each with the name maccabi.mjs writes into the PDF so a test can tell which one it got. */
export const PORTAL_PDF = {
  ...under(`${mine("DirectorshipAPI")}/letters_for_member`, {
    "mail-ref-7/mail-doc-7/pdf": "mailing-7",
    // The letter of the mailings list in records.mjs.
    "post-ref-9/post-doc-9/pdf": "post-9",
  }),
  ...under(mine("DirectorshipAPI"), { "insurance/seniority/pdf": "seniority-letter" }),
  ...under(mine("MedicalFileAPI"), {
    "vaccinations/pdf": "vaccine-group-card",
    getAgilePointPdf: "health-declaration-form",
  }),
  [`${mac("DirectorshipAPI")}/v1/payer/${ME}/termsofuse`]: "direct-debit-terms",
};

/**
 * The second doctor inquiry of the fake: a medical-form request that names an open medical record
 * instead of a visit. maccabi.mjs lists the row and serves the detail.
 */
export const inquiryRow2 = {
  status_update_date: "2026-08-19",
  request_status_code: "1",
  request_status: "טופל",
  service_provider_name: SECOND_DOCTOR,
  type: "medical_form_request",
  request_id: "inq-2",
  member_id_code: 0,
  member_id: String(OWNER),
};
export const inquiryDetail2 = () => ({
  medical_forms_details: [],
  prescription_user_drugs_indication: [],
  approval_request_details: [],
  prescription_largo_code_list: [],
  open_medical_record_number: "omr-1",
  request_status_desc: inquiryRow2.request_status,
  doctor_name: SECOND_DOCTOR,
  update_date: inquiryRow2.status_update_date,
  creation_date: "2026-08-17",
  doctor_remark: "הטופס מולא ונשלח",
  patient_remark: "מבקש טופס רפואי",
  user_code: 0,
  user_id: OWNER,
  request_id: inquiryRow2.request_id,
});
