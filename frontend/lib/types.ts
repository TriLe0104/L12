export type Role = "admin" | "manager" | "user" | "viewer";

/** The role hierarchy, least authority first. Index is the rank; mirrors ROLE_RANK
 *  on the server. Every role check in the UI derives from this one ordering. */
export const ROLE_ORDER: Role[] = ["viewer", "user", "manager", "admin"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  user: "User",
  viewer: "Viewer",
};

export const roleRank = (role: Role): number => ROLE_ORDER.indexOf(role);

/** Most authority first — the order pickers should show. */
export const ROLES_HIGH_TO_LOW: Role[] = [...ROLE_ORDER].reverse();

export type POStatus = string;

export type Inspection = string;

/** Kanban column key — day-one values match the old Stage enum. */
export type Stage = string;

export type Priority = string;

/** highest urgency first — day-one seed; prefer board settings selectionLists.priority */
export const PRIORITY_ORDER: Priority[] = ["hot", "high", "normal", "low"];

export const INSPECTION_ORDER: Inspection[] = ["formal", "standard", "source", "none"];

export const HARDWARE_ORDER = ["no", "yes"] as const;

export interface OwnerBrief {
  id: string;
  name: string;
  initials: string;
  avatar_url: string | null;
}

/** A person an order can be handed to — what `/api/users/assignable` returns.
 *  Narrower than `User` on purpose: the picker never needs an email. */
export interface Assignee extends OwnerBrief {
  role: Role;
}

/** Who last changed an order and when, derived server-side from the activity
 *  trail rather than stored on the order. `at` is sent with an explicit UTC
 *  offset, so `new Date(at)` is a real instant. */
export interface LastModified {
  by: OwnerBrief;
  at: string;
  action: string;
}

export interface PurchaseOrder {
  id: string;
  job_no: string;
  po_number: string;
  part_number: string;
  qty: number;
  due_date: string;
  dims: string | null;
  mat_dim: string | null;
  material: string | null;
  finish: string | null;
  inspection: Inspection;
  hardware: boolean;
  status: POStatus;
  status_label: string;
  stage: Stage;
  priority: Priority;
  priority_label: string;
  locked: boolean;
  customer: string | null;
  note: string | null;
  thumbnail_url: string | null;
  /** the one 3D model slot, alongside the photo rather than instead of it */
  model_url: string | null;
  model_filename: string | null;
  model_size: number | null;
  owner: OwnerBrief | null;
  /** Admin-defined attributes; keys match board settings customFields. */
  custom_fields: Record<string, string | number | null> | null;
  /** Editable traveler packet overrides persisted on the PO. */
  traveler_draft?: Record<string, string | number | null> | null;
  created_at: string;
  updated_at: string;
  /** Null only when no attributable change to the order exists in the trail. */
  last_modified: LastModified | null;
  /** Notes on this order; derived server-side so the dashboard badge never N+1s. */
  comment_count: number;
}

/** An order as the editor holds it. Reads carry the owner expanded; writes carry
 *  the id, and an explicit `null` is how the picker says Unassigned — leaving it
 *  out means "don't touch the owner". */
export type PODraft = Partial<PurchaseOrder> & { owner_id?: string | null };

export interface User {
  id: string;
  email: string;
  name: string;
  org: string | null;
  role: Role;
  avatar_url: string | null;
  is_active: boolean;
  is_pending: boolean;
  initials: string;
  created_at: string;
  last_login_at: string | null;
}

export interface ActivityItem {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
  actor: OwnerBrief | null;
}

/** A note on a purchase order. Separate from activity — does not move Modified. */
export interface POComment {
  id: string;
  body: string;
  created_at: string;
  actor: OwnerBrief | null;
}

export interface StatusMeta {
  value: string;
  label: string;
  tone: string;
}

export interface StageMeta {
  value: string;
  label: string;
  tone: string;
  statuses: string[];
}
