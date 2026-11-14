/**
 * The last step before a result is printed or returned to a model: fields that identify a person or
 * open a session are taken out, whatever depth they sit at.
 *
 * Readers pass on everything Maccabi sent. Removal is by field name alone; clinical text is left as
 * it is, so a redacted result is still personal data and is not anonymous.
 */

/** Field names, in the folded form `fold` produces, whose values are never output. */
const WITHHELD = new Set(
  [
    // Numbers that identify the member, and the account objects built around them.
    "memberid memberidcode membertechnicalid patientid patientidcode idnumber nationalid usercode",
    "loggedcustomerinfo currentcustomerinfo familydata authorizationtoaccount",
    "idtech checksumid checksum passportnumber accountnumber",
    // Numbers that identify somebody else an account answer mentions: the payer, relatives, the
    // addressee of a letter, the person who viewed or filed something, a baby, an authorized user.
    "userid primaryid primaryidcode recipientid recipientidcode payerid payeridcode",
    "paysid paysidcode unifierid unifieridcode viewbyuserid requestedbyid requestedbyidcode",
    "infantid infantidcode",
    // Anything that is, or carries, a credential for the session or for signing in.
    "authorization apiauthorization authentication cookie cookies setcookie mrhsession lastmrhsession",
    "token accesstoken refreshtoken idtoken apikey jwt session sessionid",
    "samlresponse relaystate password otp",
    // What a phone registers for push messages with.
    "devicetoken udid",
    // The imaging viewer prints the patient's name and birth date next to the scan.
    "patientname patientbirthdate viewportlabels",
  ].flatMap((names) => names.split(" ")),
);

/*
 * Two things stay in on purpose.
 * Download links and their signatures (`pdf_link`, `file_link`, `hash`, `timestamp`): Maccabi issues
 * new ones with every answer and they work only together with the session cookies, which are
 * withheld.
 * `patientSex`: a scan is read in light of it, and it singles nobody out.
 */

/**
 * In a bag of raw DICOM attributes, the tags that name a person: every tag of the patient group,
 * and the identification-code sequences of the clinicians involved (referring, performing, reading,
 * operating, requesting) and of the observer.
 */
const PATIENT_GROUP = "0010";
const PERSON_TAGS = new Set([
  "00080096",
  "00081049",
  "00081052",
  "00081062",
  "00321031",
  "0040000b",
  "00401101",
  "0040a07c",
]);
const DICOM_TAG = /^[0-9a-f]{8}$/;

/** `member_id`, `memberId` and `MemberID` all fold to `memberid`: lower case, letters and digits only. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** For the `attributes` of an imaging answer, keyed by tag number in hex: the scan stays, the person goes. */
function redactDicomAttributes(input: unknown): unknown {
  if (!isPlainRecord(input)) return redact(input);
  const kept: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(input)) {
    const tag = name.toLowerCase().replace(/[^0-9a-f]/g, "");
    const withheld = DICOM_TAG.test(tag)
      ? tag.startsWith(PATIENT_GROUP) || PERSON_TAGS.has(tag)
      : WITHHELD.has(fold(name));
    if (!withheld) kept[name] = redact(inner);
  }
  return kept;
}

/** Returns a copy of `input`, all the way down, that lacks every withheld field. */
export function redact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input !== "object" || input === null) return input;
  // Binary content has no named fields, and visiting it byte by byte would be slow for nothing.
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return input;
  const kept: Record<string, unknown> = {};
  for (const [name, inner] of Object.entries(input)) {
    const folded = fold(name);
    if (WITHHELD.has(folded)) continue;
    kept[name] = folded === "attributes" ? redactDicomAttributes(inner) : redact(inner);
  }
  return kept;
}
