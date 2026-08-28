"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { api, setToken } from "./api";
import { ROLES_HIGH_TO_LOW, roleRank, type Role, type User } from "./types";

/** Where a signed-in session belongs. */
export const LANDING = "/cluster";

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  /** re-read the signed-in account, e.g. after an admin changes their own role */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  signIn: async () => {},
  signOut: () => {},
  refreshUser: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password);
      setToken(res.access_token);
      setUser(res.user);
      router.push(LANDING);
    },
    [router],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    router.push("/login");
  }, [router]);

  const refreshUser = useCallback(async () => {
    setUser(await api.me());
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

/* ---------- permissions, all derived from the rank ordering in types.ts ---------- */

/** The floors, named for what they protect. Mirrors backend/app/security.py. */
const EDITOR_FLOOR: Role = "manager"; // changing purchase orders
const STATUS_FLOOR: Role = "user"; // status / stage moves on unlocked orders
const PEOPLE_FLOOR: Role = "manager"; // reading the directory and managing existing people
const LOCKED_PO_FLOOR: Role = "admin"; // working through a locked order

const hasRank = (user: User | null, floor: Role) =>
  !!user && roleRank(user.role) >= roleRank(floor);

export const canEdit = (user: User | null) => hasRank(user, EDITOR_FLOOR);

/** Status and kanban stage — narrower than canEdit; does not open other fields. */
export const canEditStatus = (user: User | null) => hasRank(user, STATUS_FLOOR);

/** Whether the Users page shows the directory and existing-account controls. */
export const canAdministerPeople = (user: User | null) => hasRank(user, PEOPLE_FLOOR);

/** You may only act on someone strictly below you; admins are exempt.
 *  Mirrors assert_may_manage on the server so a Manager meets a disabled
 *  control rather than a 403. */
export const canManageUser = (actor: User | null, target: User | null) =>
  canAdministerPeople(actor) &&
  !!target &&
  (actor!.role === "admin" || roleRank(actor!.role) > roleRank(target.role));

/** The roles this actor may hand out: strictly below their own, or all for an admin. */
export const assignableRoles = (actor: User | null): Role[] =>
  !canAdministerPeople(actor)
    ? []
    : ROLES_HIGH_TO_LOW.filter(
        (r) => actor!.role === "admin" || roleRank(actor!.role) > roleRank(r),
      );

/** Why a card is read-only for this user. Mirrors the server's 403 text. */
export const LOCKED_REASON =
  "This order is locked. Only an admin can change or unlock it.";

/** An editor can lock any order, but a locked one narrows to admin —
 *  clearing the lock is itself a change, so it needs the same rank. */
export const canModifyPO = (user: User | null, po: { locked: boolean } | null) =>
  canEdit(user) && (!po?.locked || hasRank(user, LOCKED_PO_FLOOR));

/** Status/stage on an unlocked order (or any order, for an admin). */
export const canModifyStatus = (user: User | null, po: { locked: boolean } | null) =>
  canEditStatus(user) && (!po?.locked || hasRank(user, LOCKED_PO_FLOOR));

/** Board settings — Admin only. */
export const canEditBoardSettings = (user: User | null) => hasRank(user, "admin");
