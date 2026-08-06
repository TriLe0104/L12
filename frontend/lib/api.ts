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

/** Uploaded images come back as API-relative paths like `/uploads/ab12.png`. */
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
  register: (name: string, email: string, password: string) =>
    request<{ access_token: string; user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
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
  listComments: (id: string) =>
    request<POComment[]>(`/api/purchase-orders/${id}/comments`),
  addComment: (id: string, body: string) =>
    request<POComment>(`/api/purchase-orders/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
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
