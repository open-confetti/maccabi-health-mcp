/**
 * serguide, Maccabi's public directory of doctors, labs and therapists, which the tool reads without
 * a session. Four addresses are answered, one for each step of a lookup:
 *   - the doctors landing page, whose catalog of specialties and cities is a JSON literal inside an
 *     inline script;
 *   - the settings call, from which the labs-and-therapists category takes that same catalog;
 *   - a search, which always finds one provider, on the first of several pages;
 *   - that provider's card.
 * Key names (their spelling too: TITEL, PARTIALLY_ADRESS, Relevnt_Populat) and value types are the
 * live ones, the provider is made up. Under the `listing-challenged` scenario every address answers with
 * the kind of page the host shows a client it takes for a robot.
 */
const HOST = "https://serguide.maccabi4u.co.il";
const API = `${HOST}/webapi/api`;
const LANDING = `${HOST}/heb/doctors/`;

const DOCTORS_CHAPTER = "001";
/** Labs and therapists: positions with no employee behind them. */
const LABS_CHAPTER = "003";

const SPECIALTY = "נוירולוגיה";
const TOWN = "קריית פלוני";
const FRONT_DESK = { Title: "מזכירות", Value: "03-0000005" };
/** The provider's identity is a number in a search row and zero-padded text on the card. */
const POSITION = 4000;
const EMPLOYEE = 50000;
const padded = (identity) => String(identity).padStart(6, "0");

const CATALOG = { Fields: [{ K: "101", V: SPECIALTY }], Cities: [{ K: "7300", V: TOWN }] };
const INITIAL_STATE = { settings: { doctors: { Settings: { category: "Doctors_001" }, Data: CATALOG } } };
const LANDING_PAGE = `<html><script>window.__INITIAL_STATE__ = ${JSON.stringify(INITIAL_STATE)};</script></html>`;
const CHALLENGE_PAGE = "<html><body>Checking that you are not a robot.</body></html>";

/** The same `value` under every one of the space-separated `keys`: the answers are mostly unfilled fields. */
const all = (keys, value) => Object.fromEntries(keys.split(" ").map((key) => [key, value]));

const searchRow = (chapter, serial) => ({
  ItemKeyIndex: `made-up-row-${serial}`,
  CHAPTER_CODE: chapter,
  PositionId: POSITION,
  EmployeeNumber: chapter === LABS_CHAPTER ? 0 : EMPLOYEE,
  TITEL: "פרופ'",
  FIRST_NAME: "פלונית",
  LAST_NAME: "אלמוני",
  CITY_NAME: TOWN,
  PARTIALLY_ADRESS: "שדרות הבדיון 8",
  PHONENUMBERS: [{ ...FRONT_DESK, Type: 1 }],
  TREAT_AREA_1: SPECIALTY,
  ...all("TREAT_AREA_2 TREAT_AREA_3 TREAT_AREA_4 TREAT_AREA_5 TREAT_AREA_6 SERVICE_NAME", ""),
});

const card = (chapter) => ({
  Success: true,
  ErrorCode: 0,
  Chapter_Code: chapter,
  PositionId: padded(POSITION),
  Pernr: chapter === LABS_CHAPTER ? "" : padded(EMPLOYEE),
  ...all("Access Age_Range_From Age_Range_To First_Name Full_Adress House_Number Last_Name Neighborhood", ""),
  ...all("Posta Referring_Text Relevnt_Populat Service_Name Street_Name Titel Treat_Area_String", ""),
  City_Name: TOWN,
  Languages: ["אנגלית"],
  Treat_Areas: [{ TreatCode: "58", TreatArea: SPECIALTY }],
  ContactDetails: [{ ...FRONT_DESK, Type: 1, Code: "3", IsDirectContact: false }],
  Schedules: [
    {
      Schedule_Type: "2",
      Schedule_Desc: "קבלת קהל",
      Schedule_Details: [
        {
          Week_Day: "3",
          Week_Day_S: "ג",
          Week_Day_L: "שלישי",
          Week_Day_Eng: null,
          Shift_Start_H: "15:30",
          Shift_End_H: "18:45",
          Frequency_Desc: "אחת לשבועיים",
          Remark_Desc: "בתיאום מראש בלבד",
        },
      ],
    },
  ],
  ...all("ResumeLines Treatments", []),
  ...all("NameRemarks ContactRemarks DirectionRemarks GeneralRemarks NoticeRemarks ProfessionRemarks", []),
  // A remark may carry a link, which the tool leaves out.
  BoldComments: [
    {
      Remark_Text: "המרפאה סגורה בחגים",
      URL: "https://example.invalid/never-shown",
      Line_Number: "2",
      NewLine: true,
      Mlh: "",
    },
  ],
});

let searches = 0;
/** What each JSON address answers to the body it was posted. */
const ANSWERS = {
  [`${API}/SettingsForSearch/GetSettingsForSearch/`]: () => ({
    Settings: { category: "LabsAndTherapists_003" },
    Data: CATALOG,
  }),
  [`${API}/SearchPage/GetSearchPageSearch/`]: (asked) => {
    const chapter = asked.ChapterId ?? DOCTORS_CHAPTER;
    searches += 1;
    return {
      Success: true,
      Errors: [],
      Items: [searchRow(chapter, searches)],
      TotalItems: 27,
      NumOfPages: 3,
      SelectedTab: chapter === LABS_CHAPTER ? null : "2",
    };
  },
  [`${API}/ProviderDetails/`]: (asked) => card(asked.ChapterId ?? DOCTORS_CHAPTER),
};

/** The fake's answer to one directory request, or null when the address is not one of the four. */
export function directory(href, posted, scenario, respond, json) {
  const page = (markup) => respond(href, markup, 200, { "content-type": "text/html" });
  if (href !== LANDING && !Object.hasOwn(ANSWERS, href)) return null;
  if (scenario === "listing-challenged") return page(CHALLENGE_PAGE);
  if (href === LANDING) return page(LANDING_PAGE);
  return json(href, ANSWERS[href](typeof posted === "string" ? JSON.parse(posted) : {}));
}
