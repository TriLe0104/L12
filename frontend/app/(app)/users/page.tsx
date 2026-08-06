"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ActivityList } from "@/components/ActivityList";
import { Avatar } from "@/components/Avatar";
import { api, assetUrl } from "@/lib/api";
import { assignableRoles, canAdministerPeople, canManageUser, useAuth } from "@/lib/auth";
import { ROLE_LABEL, ROLES_HIGH_TO_LOW, type ActivityItem, type Role, type User } from "@/lib/types";

export default function UsersPage() {
  const { user: me, refreshUser } = useAuth();
  // Manager and above administer people; what they may do to any given person is
  // then narrowed per row by canManageUser, mirroring the server's rank rule.
  const canAdmin = canAdministerPeople(me);
  const isAdmin = me?.role === "admin";
  const canAssign = assignableRoles(me);

  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "", org: "", role: "viewer" as Role });
  const [newPassword, setNewPassword] = useState("");
  const [passwordNote, setPasswordNote] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [orgDraft, setOrgDraft] = useState("");
  const [orgNote, setOrgNote] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameNote, setNameNote] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoDragOver, setPhotoDragOver] = useState(false);

  const selected = users.find((u) => u.id === selectedId) ?? null;
  // Everyone keeps their own photo; managing someone else's record needs rank over them.
  const canManageSelected = canManageUser(me, selected);
  // Your own name and photo are yours at any rank; someone else's needs rank over them.
  const canEditProfile = !!selected && (selected.id === me?.id || canManageSelected);
  // Delete is Admin-only and never offered on your own row (mirrors the API).
  const canDeleteSelected = !!isAdmin && !!selected && selected.id !== me?.id;

  const load = useCallback(async () => {
    // Below Manager the directory is closed, and there is nothing to browse anyway:
    // the only record you may see is your own, and the auth context already has it.
    // So don't ask -- a fetch here would 403 and leave the page empty.
    if (!canAdmin) {
      setUsers(me ? [me] : []);
      setSelectedId(me?.id ?? null);
      return;
    }
    const params: Record<string, string | undefined> = {};
    if (query.trim()) params.q = query.trim();
    if (roleFilter) params.role = roleFilter;
    const list = await api.listUsers(params);
    setUsers(list);
    setSelectedId((current) => current ?? list[0]?.id ?? null);
  }, [canAdmin, me, query, roleFilter]);

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const loadOrgs = useCallback(() => {
    // Org suggestions only feed the invite and org fields, both administrative.
    if (!canAdmin) return;
    api.orgs().then(setOrgs).catch(() => undefined);
  }, [canAdmin]);

  useEffect(loadOrgs, [loadOrgs]);

  useEffect(() => {
    setNewPassword("");
    setPasswordNote(null);
    setOrgNote(null);
    setPhotoError(null);
    if (!selectedId) return setActivity([]);
    api.userActivity(selectedId).then(setActivity).catch(() => setActivity([]));
  }, [selectedId]);

  useEffect(() => {
    setOrgDraft(selected?.org ?? "");
  }, [selected?.id, selected?.org]);

  useEffect(() => {
    setNameDraft(selected?.name ?? "");
    setNameNote(null);
  }, [selected?.id, selected?.name]);

  const reloadActivity = (id: string) =>
    api.userActivity(id).then(setActivity).catch(() => undefined);

  async function savePhoto(avatar_url: string | null) {
    if (!selected) return;
    const updated = await api.updateUser(selected.id, { avatar_url });
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    if (updated.id === me?.id) await refreshUser();
    await reloadActivity(updated.id);
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file || !selected || !canEditProfile) return;
    setPhotoUploading(true);
    setPhotoError(null);
    try {
      if (selected.id === me?.id) {
        // Your own photo goes through the self-service route, which stores and
        // applies it in one call and is open at every rank. The general image
        // upload is editor-only, so a User or a Viewer can't take that path.
        const updated = await api.uploadOwnAvatar(file);
        setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
        await refreshUser();
        await reloadActivity(updated.id);
      } else {
        await savePhoto((await api.uploadImage(file)).url);
      }
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setPhotoUploading(false);
    }
  }

  async function removePhoto() {
    setPhotoError(null);
    try {
      await savePhoto(null);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Could not remove photo");
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setPasswordNote(null);
    if (newPassword.length < 8) {
      setError("Use at least 8 characters");
      return;
    }
    try {
      await api.updateUser(selected.id, { password: newPassword });
      setNewPassword("");
      setPasswordNote("Password updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password");
    }
  }

  async function changeRole(role: Role) {
    if (!selected || role === selected.role) return;
    setError(null);

    const demotingSelf = selected.id === me?.id && me.role === "admin" && role !== "admin";
    if (
      demotingSelf &&
      !window.confirm(
        `Change your own role to ${ROLE_LABEL[role]}? You will lose Admin access — ` +
          `including the right to give it back to yourself.`,
      )
    ) {
      return;
    }

    try {
      const updated = await api.updateUser(selected.id, { role });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      if (updated.id === me?.id) await refreshUser();
      await reloadActivity(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function saveOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setOrgNote(null);
    try {
      const updated = await api.updateUser(selected.id, { org: orgDraft.trim() || null });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      if (updated.id === me?.id) await refreshUser();
      setOrgNote(updated.org ? `Assigned to ${updated.org}.` : "Org cleared.");
      loadOrgs();
      await reloadActivity(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign org");
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    setNameNote(null);
    const next = nameDraft.trim();
    if (!next) {
      setError("A name can't be blank");
      return;
    }
    try {
      const updated = await api.updateUser(selected.id, { name: next });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      if (updated.id === me?.id) await refreshUser();
      setNameNote("Name updated.");
      await reloadActivity(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update name");
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createUser({ ...invite, org: invite.org.trim() || null });
      setUsers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(created.id);
      setInviting(false);
      setInvite({ name: "", email: "", org: "", role: "viewer" });
      loadOrgs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite failed");
    }
  }

  async function deleteSelected() {
    if (!selected || !canDeleteSelected) return;
    setError(null);
    if (
      !window.confirm(
        `Delete ${selected.name} (${selected.email})?\n\n` +
          `This permanently removes the account and cannot be undone.`,
      )
    ) {
      return;
    }
    const removedId = selected.id;
    try {
      await api.deleteUser(removedId);
      const next = users.filter((u) => u.id !== removedId);
      setUsers(next);
      setSelectedId((current) => (current === removedId ? (next[0]?.id ?? null) : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const pending = users.filter((u) => u.is_pending).length;

  return (
    <>
      <datalist id="org-options">
        {orgs.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      <div className="page-head">
        <div>
          <h1 className="page-title">{canAdmin ? "Users" : "My profile"}</h1>
          <p className="page-sub">
            {canAdmin
              ? "Directory of every account holder. Search by name and filter by role."
              : "Your name and photo. Ask an administrator to change your role or org."}
          </p>
        </div>
        {canAdmin && (
          <div className="head-tools">
            <button className="btn btn-primary" onClick={() => setInviting((v) => !v)}>
              {inviting ? "Cancel" : "+ Invite user"}
            </button>
          </div>
        )}
      </div>

      {inviting && (
        <form
          className="detail-panel"
          onSubmit={submitInvite}
          style={{ marginBottom: 16, display: "grid", gap: 10 }}
        >
          <div className="form-grid">
            <label>
              Name
              <input
                className="field"
                required
                value={invite.name}
                onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              />
            </label>
            <label>
              Email
              <input
                className="field"
                type="email"
                required
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              />
            </label>
            <label>
              Org
              <input
                className="field"
                list="org-options"
                placeholder="e.g. Rack"
                value={invite.org}
                onChange={(e) => setInvite({ ...invite, org: e.target.value })}
              />
            </label>
            <label>
              Global role
              <select
                className="field"
                aria-label="Invite role"
                value={invite.role}
                onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}
              >
                {canAssign.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <button className="btn btn-primary" type="submit">
              Send invite
            </button>
          </div>
        </form>
      )}

      <div className="users-layout" data-solo={!canAdmin}>
        {canAdmin && (
          <div className="list-panel">
            <div className="list-head">
              <input
                className="field"
                placeholder="Search by name or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="field"
                aria-label="Filter by role"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="">All roles</option>
                {ROLES_HIGH_TO_LOW.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>

            <div className="list-count">
              <span>People · {users.length}</span>
              {pending > 0 && <span>{pending} pending</span>}
            </div>

            {users.map((u) => (
              <button
                key={u.id}
                className="user-row"
                data-active={u.id === selectedId}
                onClick={() => setSelectedId(u.id)}
              >
                <Avatar initials={u.initials} avatarUrl={u.avatar_url} />
                <div className="user-meta">
                  <b>{u.name}</b>
                  <small>{u.org ? `${u.org} · ${u.email}` : u.email}</small>
                </div>
                <span className="tag" data-role={u.role}>
                  {ROLE_LABEL[u.role]}
                </span>
              </button>
            ))}
            {users.length === 0 && <div className="empty">No users match.</div>}
          </div>
        )}

        <div className="detail-panel">
          {!selected ? (
            <div className="empty">Select a person to see their access and activity.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <Avatar size="lg" initials={selected.initials} avatarUrl={selected.avatar_url} />
                <div>
                  <h2 style={{ margin: 0, fontSize: 20, letterSpacing: "-0.02em" }}>
                    {selected.name}
                  </h2>
                  <div style={{ color: "var(--steel)", fontSize: 13 }}>{selected.email}</div>
                </div>
                <span className="tag" data-role={selected.role} style={{ marginLeft: "auto" }}>
                  {ROLE_LABEL[selected.role]}
                </span>
              </div>

              <div className="section-label">Name</div>
              {canEditProfile ? (
                <form className="inline-controls" onSubmit={saveName}>
                  <input
                    className="field"
                    aria-label="Display name"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    style={{ flex: "1 1 12rem", maxWidth: "18rem" }}
                  />
                  <button
                    className="btn"
                    type="submit"
                    disabled={!nameDraft.trim() || nameDraft.trim() === selected.name}
                  >
                    Save
                  </button>
                  {nameNote && (
                    <span style={{ fontSize: "0.75rem", color: "var(--go)" }}>{nameNote}</span>
                  )}
                </form>
              ) : (
                <div style={{ fontSize: 13 }}>{selected.name}</div>
              )}

              <div className="section-label">Photo</div>
              <div className="inline-controls">
                <div
                  className="thumb-drop photo-drop"
                  data-dragover={photoDragOver}
                  onClick={() => canEditProfile && photoRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (canEditProfile) setPhotoDragOver(true);
                  }}
                  onDragLeave={() => setPhotoDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setPhotoDragOver(false);
                    void uploadPhoto(e.dataTransfer.files[0]);
                  }}
                  role="button"
                  tabIndex={canEditProfile ? 0 : -1}
                  onKeyDown={(e) => e.key === "Enter" && canEditProfile && photoRef.current?.click()}
                  title={canEditProfile ? "Click or drop a profile photo" : "Photo"}
                >
                  {selected.avatar_url ? (
                    // Plain <img>: uploads come from the API origin, which next/image
                    // would only accept with a remotePatterns entry.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetUrl(selected.avatar_url) ?? ""} alt={selected.name} />
                  ) : (
                    <span>{photoUploading ? "UPLOADING…" : canEditProfile ? "+ PHOTO" : "NO PHOTO"}</span>
                  )}
                  {selected.avatar_url && canEditProfile && (
                    <button
                      type="button"
                      className="thumb-clear"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removePhoto();
                      }}
                      aria-label="Remove photo"
                    >
                      ×
                    </button>
                  )}
                  <input
                    ref={photoRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(e) => void uploadPhoto(e.target.files?.[0])}
                  />
                </div>
                <span style={{ fontSize: "0.75rem", color: "var(--steel)", flex: "1 1 10rem" }}>
                  {canEditProfile
                    ? "Click or drop a PNG, JPEG, WebP or GIF under 8 MB. Without one, initials are used."
                    : "People manage their own photo; managers can change it for anyone below them."}
                </span>
              </div>
              {photoError && <p className="error">{photoError}</p>}

              <div className="section-label">Global role</div>
              <div className="inline-controls">
                {/* No picker at all unless this person is below you: a role you may
                    not assign is never even rendered as an option. */}
                {canManageSelected ? (
                  <select
                    className="field"
                    aria-label="Global role"
                    value={selected.role}
                    onChange={(e) => changeRole(e.target.value as Role)}
                    style={{ flex: "0 1 11rem" }}
                  >
                    {canAssign.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="tag" data-role={selected.role} style={{ marginLeft: 0 }}>
                    {ROLE_LABEL[selected.role]}
                  </span>
                )}
                <span style={{ fontSize: "0.75rem", color: "var(--steel)" }}>
                  {!canAdmin
                    ? "Managers and admins set roles."
                    : !canManageSelected
                      ? selected.id === me?.id
                        ? "You can't change your own role."
                        : "Only an admin can change this account."
                      : selected.id === me?.id
                        ? "This is your own account — dropping admin signs you out of these controls."
                        : "Controls what this person can do across the shop."}
                </span>
              </div>

              <div className="section-label">Org</div>
              {canManageSelected ? (
                <form className="inline-controls" onSubmit={saveOrg}>
                  <input
                    className="field"
                    list="org-options"
                    placeholder="Unassigned — pick or type a new org"
                    value={orgDraft}
                    onChange={(e) => setOrgDraft(e.target.value)}
                    style={{ flex: "1 1 12rem", maxWidth: "18rem" }}
                  />
                  <button
                    className="btn"
                    type="submit"
                    disabled={orgDraft.trim() === (selected.org ?? "")}
                  >
                    Assign
                  </button>
                  {orgNote && (
                    <span style={{ fontSize: "0.75rem", color: "var(--go)" }}>{orgNote}</span>
                  )}
                </form>
              ) : (
                <div style={{ fontSize: 13 }}>{selected.org ?? "Unassigned"}</div>
              )}

              <div className="section-label">Account</div>
              <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                <div>
                  Status: <b>{selected.is_pending ? "Pending invite" : selected.is_active ? "Active" : "Disabled"}</b>
                </div>
                <div>
                  Last sign-in:{" "}
                  <b>
                    {selected.last_login_at
                      ? new Date(selected.last_login_at).toLocaleString()
                      : "Never"}
                  </b>
                </div>
              </div>

              {canManageSelected && (
                <>
                  <div className="section-label">Password</div>
                  <form onSubmit={changePassword} className="inline-controls">
                    <input
                      className="field"
                      type="password"
                      placeholder={
                        selected.id === me?.id ? "New password for your account" : "Set a new password"
                      }
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      style={{ flex: "1 1 12rem", maxWidth: "18rem" }}
                    />
                    <button className="btn" type="submit" disabled={newPassword.length < 8}>
                      Update
                    </button>
                    {passwordNote && (
                      <span style={{ fontSize: "0.75rem", color: "var(--go)" }}>{passwordNote}</span>
                    )}
                  </form>
                </>
              )}

              {canDeleteSelected && (
                <>
                  <div className="section-label">Danger zone</div>
                  <div className="inline-controls">
                    <button
                      type="button"
                      className="btn btn-danger"
                      aria-label={`Delete ${selected.name}`}
                      onClick={() => void deleteSelected()}
                    >
                      Delete user
                    </button>
                    <span style={{ fontSize: "0.75rem", color: "var(--steel)", flex: "1 1 12rem" }}>
                      Permanently removes this account. Orders they own must be reassigned first.
                    </span>
                  </div>
                </>
              )}

              <div className="section-label">Recent activity · {activity.length}</div>
              <ActivityList items={activity} />

              {error && <p className="error">{error}</p>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
