"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { Assignee, StaffChecklistItem, StaffTask } from "@/lib/types";

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newItem(text = ""): StaffChecklistItem {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, text, done: false };
}

export function StaffTaskDrawer({
  task,
  defaultDue,
  people,
  onClose,
  onSaved,
  onDeleted,
}: {
  task: StaffTask | null;
  defaultDue?: string;
  people: Assignee[];
  onClose: () => void;
  onSaved: (saved: StaffTask) => void;
  onDeleted: (id: string) => void;
}) {
  const { user } = useAuth();
  const isEditor = canEdit(user);
  const isCreator = !!task && user?.id === task.creator.id;
  const isAssignee = !!task && user?.id === task.assignee.id;
  const canEditAll = isEditor || isCreator;
  const canCheck = canEditAll || isAssignee;

  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [dueDate, setDueDate] = useState(task?.due_date ?? defaultDue ?? todayIso());
  const [assigneeId, setAssigneeId] = useState(task?.assignee.id ?? people[0]?.id ?? "");
  const [checklist, setChecklist] = useState<StaffChecklistItem[]>(
    task?.checklist?.length ? task.checklist : [],
  );
  const [draftItem, setDraftItem] = useState("");
  const [done, setDone] = useState(!!task?.done);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const doneCount = useMemo(
    () => checklist.filter((item) => item.done).length,
    [checklist],
  );

  function addItem() {
    const text = draftItem.trim();
    if (!text || !canEditAll) return;
    setChecklist((prev) => [...prev, newItem(text)]);
    setDraftItem("");
  }

  async function save() {
    if (!canEditAll && !task) return;
    if (canEditAll && (!title.trim() || !assigneeId)) {
      setError("Title and assignee are required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        due_date: dueDate,
        assignee_id: assigneeId,
        checklist,
        done,
      };
      const saved = task
        ? await api.updateStaffTask(
            task.id,
            canEditAll
              ? payload
              : { checklist, done },
          )
        : await api.createStaffTask(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the task");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!task || !isEditor) return;
    if (!window.confirm("Delete this task?")) return;
    setBusy(true);
    try {
      await api.deleteStaffTask(task.id);
      onDeleted(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the task");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer staff-task-drawer" role="dialog" aria-label={task ? "Task" : "New task"}>
        <header className="drawer-head">
          <strong>{task ? "Task" : "New task"}</strong>
          <div className="drawer-head-actions">
            {task && isEditor && (
              <button className="btn" onClick={() => void remove()} disabled={busy}>
                Delete
              </button>
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
            {(canEditAll || (task && canCheck)) && (
              <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </header>
        <div className="drawer-body">
          {error && <div className="staff-task-error">{error}</div>}
          <div className="form-grid">
            <label className="wide">
              Title
              <input
                className="field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!canEditAll}
                maxLength={200}
                required
              />
            </label>
            <label>
              Assign to
              {canEditAll ? (
                <select
                  className="field"
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                >
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="field" value={task?.assignee.name ?? ""} disabled />
              )}
            </label>
            <label>
              Due date
              <input
                className="field"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={!canEditAll}
              />
            </label>
            <label className="wide">
              Description
              <textarea
                className="field staff-task-notes"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canEditAll}
                maxLength={4000}
                placeholder="What needs to happen"
              />
            </label>
          </div>

          <section className="staff-task-check">
            <div className="staff-task-check-head">
              Checklist
              {checklist.length > 0 && (
                <span>
                  {doneCount} / {checklist.length}
                </span>
              )}
            </div>
            <ul>
              {checklist.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!canCheck}
                      onChange={(e) =>
                        setChecklist((prev) =>
                          prev.map((row) =>
                            row.id === item.id ? { ...row, done: e.target.checked } : row,
                          ),
                        )
                      }
                    />
                    <span data-done={item.done}>{item.text}</span>
                  </label>
                  {canEditAll && (
                    <button
                      type="button"
                      className="staff-task-remove"
                      aria-label="Remove item"
                      onClick={() =>
                        setChecklist((prev) => prev.filter((row) => row.id !== item.id))
                      }
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canEditAll && (
              <div className="staff-task-add">
                <input
                  className="field"
                  value={draftItem}
                  placeholder="Add a checklist item"
                  onChange={(e) => setDraftItem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addItem();
                    }
                  }}
                />
                <button type="button" className="btn" onClick={addItem}>
                  Add
                </button>
              </div>
            )}
          </section>

          {task && (
            <label className="staff-task-done">
              <input
                type="checkbox"
                checked={done}
                disabled={!canCheck}
                onChange={(e) => setDone(e.target.checked)}
              />
              Mark task complete
            </label>
          )}

          {task && (
            <p className="staff-task-meta">
              Created by {task.creator.name}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
