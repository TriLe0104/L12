import type {
  ActivityItem,
  Assignee,
  POComment,
  PODraft,
  PurchaseOrder,
  StageMeta,
  StatusMeta,
  User,
} from "./types";
import type { BoardSettings } from "./boardTypes";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, "") ?? "http://127.0.0.1:8000";

const TOKEN_KEY = "po_calendar_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** Uploaded assets are either API-relative (`/uploads/ab12.png`) or absolute
 *  object-storage URLs when `S3_PUBLIC_BASE_URL` is set on the API. */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith("/") ? `${API_BASE}${path}` : path;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ access_token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  authConfig: () =>
    request<{ provider: string; allow_signup: boolean }>("/api/auth/config"),
  me: () => request<User>("/api/auth/me"),

  listPOs: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<PurchaseOrder[]>(`/api/purchase-orders${qs ? `?${qs}` : ""}`);
  },
  createPO: (payload: PODraft) =>
    request<PurchaseOrder>("/api/purchase-orders", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updatePO: (id: string, payload: PODraft) =>
    request<PurchaseOrder>(`/api/purchase-orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deletePO: (id: string) =>
    request<void>(`/api/purchase-orders/${id}`, { method: "DELETE" }),
  poActivity: (id: string) => request<ActivityItem[]>(`/api/purchase-orders/${id}/activity`),
  listComments: (id: string, part?: number | null | "all") =>
    request<POComment[]>(
      `/api/purchase-orders/${id}/comments${
        part === "all" ? "?all=1" : part ? `?part=${part}` : ""
      }`,
    ),
  addComment: (id: string, body: string, part?: number | null | "all") =>
    request<POComment>(`/api/purchase-orders/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body,
        part_index: part === "all" || part == null ? null : part - 1,
      }),
    }),
  deleteComment: (poId: string, commentId: string) =>
    request<void>(`/api/purchase-orders/${poId}/comments/${commentId}`, {
      method: "DELETE",
    }),

  listUsers: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    ).toString();
    return request<User[]>(`/api/users${qs ? `?${qs}` : ""}`);
  },
  createUser: (payload: Partial<User> & { password?: string }) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: Partial<User> & { password?: string }) =>
    request<User>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteUser: (id: string) => request<void>(`/api/users/${id}`, { method: "DELETE" }),
  userActivity: (id: string) => request<ActivityItem[]>(`/api/users/${id}/activity`),
  orgs: () => request<string[]>("/api/users/orgs"),
  /** Just enough about each person to draw the owner picker. */
  assignableUsers: () => request<Assignee[]>("/api/users/assignable"),

  statuses: () => request<StatusMeta[]>("/api/meta/statuses"),
  stages: () => request<StageMeta[]>("/api/meta/stages"),

  boardSettings: () => request<BoardSettings>("/api/settings/board"),
  saveBoardSettings: (document: BoardSettings["document"]) =>
    request<BoardSettings>("/api/settings/board", {
      method: "PUT",
      body: JSON.stringify({ document }),
    }),

  uploadImage: (file: File) => postFile<{ url: string; filename: string }>("/api/uploads", file),
  addPart: (poId: string, payload: Record<string, any>) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/parts`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  setDisplayPart: (poId: string, index: number) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/display-part`, {
      method: "PATCH",
      body: JSON.stringify({ index }),
    }),
  patchPart: (poId: string, index: number, payload: Record<string, any>) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/parts/${index}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  updatePOWithPart: (
    poId: string,
    poFields: Record<string, any> | null,
    partIndex: number | null,
    partPayload: Record<string, any> | null,
  ) =>
    request<PurchaseOrder>(`/api/purchase-orders/${poId}/with-part`, {
      method: "PATCH",
      body: JSON.stringify({ fields: poFields ?? {}, part_index: partIndex, part: partPayload ?? {} }),
    }),

  /** Your own profile photo, stored and applied in one call. Open to every rank,
   *  because it can only ever write the caller's own avatar; returns the updated
   *  account. Setting someone *else's* photo is uploadImage + updateUser. */
  uploadOwnAvatar: (file: File) => postFile<User>("/api/uploads/avatar", file),

  /** A 3D model for the order's single model slot. The server validates the
   *  extension against the file's leading bytes and rejects anything else. */
  uploadModel: (file: File) =>
    postFile<{ url: string; filename: string; size: number; format: string }>(
      "/api/uploads/model",
      file,
    ),

  /** Merged traveler field map for the editable packet editor. `part` is 1-based. */
  getTraveler: (poId: string, part?: number | null) =>
    request<{
      fields: Record<string, string | number | null>;
      saved: Record<string, string | number | null> | null;
    }>(`/api/purchase-orders/${poId}/traveler${part ? `?part=${part}` : ""}`),
  /** Get a single PO by id. */
  getPO: (poId: string) => request<PurchaseOrder>(`/api/purchase-orders/${poId}`),

  /** Persist traveler_draft JSON for one part (editor floor). `part` is 1-based. */
  saveTraveler: (
    poId: string,
    fields: Record<string, string | number | null>,
    part?: number | null,
  ) =>
    request<{
      fields: Record<string, string | number | null>;
      saved: Record<string, string | number | null> | null;
    }>(`/api/purchase-orders/${poId}/traveler${part ? `?part=${part}` : ""}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    }),

  /** Silent preview fetch (no activity). */
  previewTraveler: (poId: string, fmt: PacketFmt, opts?: { part?: number; signal?: AbortSignal }) => {
    const qs = opts?.part ? `?part=${opts.part}` : "";
    return fetchBinary(`/api/purchase-orders/${poId}/traveler/${fmt}${qs}`, fmt, {
      method: "GET",
      signal: opts?.signal,
    });
  },

  /** Download packet and record “Traveler generated”. */
  generateTraveler: (
    poId: string,
    fmt: PacketFmt,
    body?: {
      fields?: Record<string, string | number | null>;
      persist?: boolean;
    },
    opts?: { part?: number; signal?: AbortSignal },
  ) => {
    const qs = opts?.part ? `?part=${opts.part}` : "";
    return fetchBinary(`/api/purchase-orders/${poId}/traveler/${fmt}${qs}`, fmt, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      headers: { "Content-Type": "application/json" },
      signal: opts?.signal,
    });
  },
};

/** Multipart upload. Deliberately not routed through `request`, which forces a
 *  JSON content type; the boundary has to come from FormData. */
async function postFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export type PacketFmt = "pdf" | "docx" | "xlsx";

/** Word / Excel only open these files when the MIME type matches the extension. */
const PACKET_MIME: Record<PacketFmt, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

/** The extension drives what the OS opens the download with, so it must always
 *  match the requested format even when the server name is missing or odd. */
function packetFilename(served: string | null, fmt: PacketFmt): string {
  const base = served?.split(/[\\/]/).pop()?.trim();
  if (!base) return `traveler.${fmt}`;
  return base.toLowerCase().endsWith(`.${fmt}`) ? base : `${base}.${fmt}`;
}

/** Binary traveler / export downloads. */
async function fetchBinary(
  path: string,
  fmt: PacketFmt,
  init: RequestInit = {},
): Promise<{ blob: Blob; filename: string }> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, detail);
  }
  const raw = await res.blob();
  const servedType = res.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const type =
    servedType && servedType !== "application/octet-stream"
      ? servedType
      : PACKET_MIME[fmt];
  const blob = raw.type === type ? raw : new Blob([raw], { type });
  // Cross-origin reads need Access-Control-Expose-Headers: Content-Disposition;
  // fall back to a format-correct name rather than an unopenable one.
  const filename = packetFilename(
    filenameFromDisposition(res.headers.get("Content-Disposition")),
    fmt,
  );
  return { blob, filename };
}
