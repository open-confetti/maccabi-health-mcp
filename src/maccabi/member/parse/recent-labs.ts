import { absent, type Guard, guardFor, type Json } from "./guards";

export interface CultureDrug {
  name_of_drug: string;
  sensitivity: string;
}

export interface CultureRow {
  bacterium_name: string;
  drugs_and_sensitivity_list: CultureDrug[];
}

export interface RecentAnalyte {
  test_id: string;
  test_desc: string;
  lab_date: string;
  result: number;
  units: string;
  min_lim: number;
  max_lim: number;
  numeric_percentage: number;
  message: string;
  message_list: string[];
  is_messages: string;
  is_follow: boolean;
  is_vitek: boolean;
  vitek_row: CultureRow[];
  has_result_file: boolean;
}

export interface RecentGroup {
  group_name: string;
  group_values: RecentAnalyte[];
}

export interface AnalytePoint extends RecentAnalyte {
  is_graph: boolean;
  doc_first_name: string;
  doc_last_name: string;
}

export interface AnalyteHistory {
  current_result: AnalytePoint;
  other_results: AnalytePoint[];
}

export interface FollowChoice {
  test_id: string | number;
  test_desc: string;
  is_follow: boolean;
}

export interface FollowedAnalytes {
  followed_counter: number;
  followed_tests: RecentAnalyte[];
  options: FollowChoice[];
}

export class RecentLabShapeError extends Error {
  constructor() {
    super("Maccabi's recent lab results are not laid out the way the portal's results pages read them");
    this.name = "RecentLabShapeError";
  }
}

const check: Guard = guardFor(() => new RecentLabShapeError());
const RESULT_BYTES = 2 * 1024 * 1024;
const finite = (value: unknown): number => (Number.isFinite(value) ? (value as number) : check.fail());
/** The portal sends a signature for its PDF getters next to some payloads; it has to be there and is never copied. */
function requireSignature(holder: Json, stampKey: "timestamp" | "time_stamp"): void {
  check.filled(holder[stampKey]);
  check.filled(holder.hash);
}

function culture(entry: unknown): CultureRow {
  const row = check.object(entry);
  return {
    bacterium_name: check.string(row.bacterium_name),
    drugs_and_sensitivity_list: check.list(row.drugs_and_sensitivity_list, 1000).map((listed) => {
      const drug = check.object(listed);
      return { name_of_drug: check.string(drug.name_of_drug), sensitivity: check.string(drug.sensitivity) };
    }),
  };
}

function analyte(entry: unknown): RecentAnalyte {
  const row = check.object(entry);
  // A result either comes with a file and the signature to fetch it, or with neither.
  const has_result_file = !absent(row.result_file);
  if (has_result_file) {
    check.filled(row.result_file);
    requireSignature(row, "time_stamp");
  } else if (!absent(row.time_stamp) || !absent(row.hash)) check.fail();
  return {
    test_id: check.filled(row.test_id),
    test_desc: check.filled(row.test_desc),
    units: check.string(row.units),
    message: check.string(row.message),
    message_list: check.list(row.message_list, 1000).map(check.string),
    lab_date: check.filled(row.lab_date),
    min_lim: finite(row.min_lim),
    max_lim: finite(row.max_lim),
    result: finite(row.result),
    numeric_percentage: check.integer(row.numeric_percentage),
    is_messages: check.filled(row.is_messages),
    is_vitek: check.flag(row.is_vitek),
    is_follow: check.flag(row.is_follow),
    vitek_row: check.list(row.vitek_row, 1000).map(culture),
    has_result_file,
  };
}

/** What the portal's latest-results page renders: the groups, their rows, long messages and culture tables. */
export function shapeRecentLabs(answer: unknown): RecentGroup[] {
  const groups = check.list(answer, 100).map((entry): RecentGroup => {
    const group = check.object(entry);
    return {
      group_name: check.filled(group.group_name),
      group_values: check.list(group.group_values, 1000).map(analyte),
    };
  });
  return check.bounded(groups, RESULT_BYTES);
}

/**
 * One analyte over time, for the test and the date the member picked: every row has to be that test,
 * and the current row that date. The report signature at the top of the answer is for the PDF getter
 * and is not copied.
 */
export function shapeAnalyteHistory(answer: unknown, analyteId: string, labDate: string): AnalyteHistory {
  if (!analyteId || !labDate) check.fail();
  const body = check.object(answer);
  requireSignature(body, "timestamp");
  const point = (entry: unknown): AnalytePoint => {
    const row = check.object(entry);
    const measured = analyte(row);
    if (measured.test_id !== analyteId) check.fail();
    return {
      ...measured,
      doc_first_name: check.string(row.doc_first_name),
      doc_last_name: check.string(row.doc_last_name),
      is_graph: check.flag(row.is_graph),
    };
  };
  const current_result = point(body.current_result);
  if (current_result.lab_date !== labDate) check.fail();
  return check.bounded(
    { current_result, other_results: check.list(body.other_results, 1000).map(point) },
    RESULT_BYTES,
  );
}

/** The watch list as it stands. Starring and unstarring a test is a PUT of the portal's that has no counterpart here. */
export function shapeFollowedAnalytes(answer: unknown): FollowedAnalytes {
  const body = check.object(answer);
  requireSignature(body, "timestamp");
  const followed_counter = check.integer(body.followed_counter);
  if (followed_counter < 0) check.fail();
  const options = check.list(body.options, 10_000).map((entry): FollowChoice => {
    const choice = check.object(entry);
    return {
      test_id: typeof choice.test_id === "number" ? check.integer(choice.test_id) : check.filled(choice.test_id),
      test_desc: check.filled(choice.test_desc),
      is_follow: check.flag(choice.is_follow),
    };
  });
  return check.bounded(
    { followed_counter, followed_tests: check.list(body.followed_tests, 1000).map(analyte), options },
    RESULT_BYTES,
  );
}
