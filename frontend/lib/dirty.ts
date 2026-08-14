import type { PODraft } from "./types";

/** Has the card editor's draft moved away from the record it was opened on?
 *
 *  The comparison is deliberately field-agnostic: it walks whatever keys the
 *  draft actually has and only names the ones the *server* owns. A field added
 *  to CardEditor later — a 3D model slot, an owner picker, anything after that —
 *  is picked up without touching this file, which is the whole point. Missing a
 *  new field would mean silently losing edits to it.
 *
 *  Everything else here exists to stop the opposite failure: a prompt about
 *  changes nobody made. A form control never hands back exactly what the API
 *  sent it, so both sides are flattened to one canonical shape first.
 */

/** Written by the server, never by the form: comparing them would report a
 *  change on every save round-trip. `stage` is derived from `status`, and the
 *  two `_label` fields from their own enum. */
const DERIVED: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "updated_at",
  "status_label",
  "priority_label",
  "stage",
  // server-derived list metadata — never form fields; must not trip the prompt
  "last_modified",
  "comment_count",
  "part_comment_counts",
  "parts_completed",
  "parts_total",
  "display_part_index",
  // traveler packet edits use a dedicated panel + API, not the card Save
  "traveler_draft",
]);

type Flat = string | number | boolean;

/** `YYYY-MM-DD` at the head of a longer timestamp — a date input only ever
 *  produces the day, but the same field can come back from the API as an
 *  instant, and those are the same due date. */
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})T/;

const flatten = (value: unknown): Flat => {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value;
  // a number input hands back NaN the moment it is cleared, which is "nothing
  // typed here" rather than a value
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "string") {
    const text = value.trim();
    return ISO_DAY.exec(text)?.[1] ?? text;
  }
  return JSON.stringify(value);
};

const same = (a: Flat, b: Flat): boolean => {
  if (a === b) return true;
  const aBlank = a === "";
  const bBlank = b === "";
  // `null`, `undefined`, an empty string and a cleared number all mean "nothing
  // here", so any of them standing in for another is not a change
  if (aBlank && bBlank) return true;
  // an absent boolean is an off boolean: a brand-new order carries no `locked`
  // key at all, while the record it is compared against carries `false`
  if (aBlank || bBlank) return a === false || b === false;
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  // a numeric field can arrive as either, depending on which side of the input
  // it came from
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return false;
};

/** Reads carry the owner expanded, writes carry an id, and the picker only sets
 *  the id once it is touched — where `null` is a real answer meaning Unassigned.
 *  Both shapes have to collapse to one value or a reassignment would compare as
 *  two unrelated fields. */
const ownerId = (draft: PODraft): string | null =>
  draft.owner_id !== undefined ? draft.owner_id : (draft.owner?.id ?? null);

const comparable = (draft: PODraft): Record<string, Flat> => {
  const out: Record<string, Flat> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (DERIVED.has(key) || key === "owner" || key === "owner_id") continue;
    out[key] = flatten(value);
  }
  out.owner_id = flatten(ownerId(draft));
  return out;
};

/** Which fields the draft has moved, by name. Sorted, so it reads the same way
 *  every time it is logged or asserted on. */
export function changedFields(baseline: PODraft, draft: PODraft): string[] {
  const before = comparable(baseline);
  const after = comparable(draft);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !same(before[key] ?? "", after[key] ?? "")).sort();
}

export const isDirty = (baseline: PODraft, draft: PODraft): boolean =>
  changedFields(baseline, draft).length > 0;
