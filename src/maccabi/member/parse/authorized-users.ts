import { type Guard, guardFor } from "./guards";

/** One person the account-permissions page lists as allowed to view this account. */
export interface AccessUser {
  /** When the current authorization runs out, in the text the page shows. */
  authentication_end_date: string;
  last_name: string;
  first_name: string;
  /** The identification number printed beside the name. */
  user_id: string | number;
}

export interface AccessList {
  /** Which of the page's two branches the answer's single message selects. */
  state: "viewer-list" | "creation-available";
  users: AccessUser[];
}

export class AccessListShapeError extends Error {}

const check: Guard = guardFor(() => new AccessListShapeError());

/** The message type decides what the page renders: the list of viewers, or the offer to add a first one. */
const STATE_BY_MESSAGE_TYPE = new Map<unknown, AccessList["state"]>([
  ["S-Success", "viewer-list"],
  ["W-Warning", "creation-available"],
]);

function shownId(value: unknown): string | number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : check.fail();
  return check.text(value, 512);
}

/** What the ordinary account-permissions viewer reads out of its answer, and nothing else from it. */
export function shapeAccessList(answer: unknown): AccessList {
  const body = check.object(answer);
  if (!Array.isArray(body.messages) || body.messages.length !== 1) check.fail();
  const verdict = check.object(body.messages[0]);
  check.text(verdict.message, 16_384);
  const state = STATE_BY_MESSAGE_TYPE.get(verdict.type) ?? check.fail();

  const listed = body.users === null ? [] : check.list(body.users, 100);
  if (state === "creation-available" && listed.length > 0) check.fail();
  const users = listed.map((entry): AccessUser => {
    const user = check.object(entry);
    return {
      first_name: check.text(user.first_name, 16_384),
      last_name: check.text(user.last_name, 16_384),
      user_id: shownId(user.user_id),
      authentication_end_date: check.text(user.authentication_end_date, 512),
    };
  });
  return check.bounded({ state, users }, 256 * 1024);
}
