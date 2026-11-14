import { account, billing, notifications, requests } from "./account";
import type { Operation } from "./define";
import { medical } from "./medical";
import { portal } from "./portal";
import { providers } from "./providers";
import { appointments } from "./scheduling";

/**
 * Every read this tool offers, defined once. The CLI commands and the MCP `operation` values are both
 * generated from this list, so the two surfaces cannot drift apart.
 */
export const OPERATIONS: readonly Operation[] = [
  ...medical,
  ...appointments,
  ...providers,
  ...account,
  ...billing,
  ...requests,
  ...notifications,
  ...portal,
];

const byName = new Map<string, Operation>();
for (const label of OPERATIONS) {
  if (byName.has(label.name)) throw new Error(`Duplicate operation name: ${label.name}`);
  byName.set(label.name, label);
}

export function findOperation(label_: string): Operation | undefined {
  return byName.get(label_);
}

export { type Category, OPERATION_GROUPS, type Operation } from "./define";
