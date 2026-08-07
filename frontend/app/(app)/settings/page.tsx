"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { BoardSettingsPreview } from "@/components/BoardSettingsPreview";
import { UnsavedChangesPrompt } from "@/components/UnsavedChangesPrompt";
import { api } from "@/lib/api";
import { canEditBoardSettings, useAuth } from "@/lib/auth";
import { useBoardSettings } from "@/lib/boardSettings";
import {
  DEFAULT_TONE_HEX,
  TONE_HEX,
  resolveToneColor,
  toColorInputValue,
  tryParseToneHex,
  type BoardDocument,
  type CardFieldConfig,
  type CustomFieldConfig,
  type CustomFieldType,
  type DashboardColumnConfig,
  type KanbanColumnConfig,
  type StatusConfig,
} from "@/lib/boardTypes";

type Tab = "card" | "statuses" | "dashboard" | "kanban";

const TABS: { id: Tab; label: string }[] = [
  { id: "card", label: "Card fields" },
  { id: "statuses", label: "Statuses" },
  { id: "dashboard", label: "Dashboard" },
  { id: "kanban", label: "Task progress" },
];

/** Native color well + hex text — opens the OS/browser color picker. */
function ToneColorField({
  value,
  onChange,
  "aria-label": ariaLabel = "Color",
}: {
  value: string;
  onChange: (hex: string) => void;
  "aria-label"?: string;
}) {
  const resolved = resolveToneColor(value);
  const [text, setText] = useState(resolved);

  useEffect(() => {
    setText(resolved);
  }, [resolved]);

  return (
    <div className="settings-tone-field">
      <input
        type="color"
        className="settings-tone-swatch"
        value={toColorInputValue(value)}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        aria-label={ariaLabel}
        title={ariaLabel}
      />
      <input
        type="text"
        className="cell-input settings-tone-hex"
        value={text}
        spellCheck={false}
        aria-label={`${ariaLabel} hex`}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = tryParseToneHex(next);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => setText(resolveToneColor(value))}
      />
    </div>
  );
}

function cloneDoc(doc: BoardDocument): BoardDocument {
  return structuredClone(doc);
}

function docsEqual(a: BoardDocument | null, b: BoardDocument | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function slugify(label: string, prefix: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 28);
  return `${prefix}_${base || "field"}`;
}

export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { document: published, loading, refresh } = useBoardSettings();

  const [draft, setDraft] = useState<BoardDocument | null>(null);
  const [baseline, setBaseline] = useState<BoardDocument | null>(null);
  const [tab, setTab] = useState<Tab>("card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const dirty = useMemo(() => !docsEqual(draft, baseline), [draft, baseline]);

  useEffect(() => {
    if (authLoading) return;
    if (!canEditBoardSettings(user)) {
      router.replace("/dashboard");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!published) return;
    const copy = cloneDoc(published);
    setDraft(copy);
    setBaseline(cloneDoc(published));
  }, [published]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const revert = useCallback(() => {
    if (!baseline) return;
    setDraft(cloneDoc(baseline));
    setError(null);
  }, [baseline]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveBoardSettings(draft);
      setDraft(cloneDoc(saved.document));
      setBaseline(cloneDoc(saved.document));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }, [draft, refresh]);

  const requestLeave = useCallback(
    (href: string) => {
      if (dirty) {
        setPendingHref(href);
        setConfirming(true);
      } else {
        router.push(href);
      }
    },
    [dirty, router],
  );

  if (authLoading || loading || !canEditBoardSettings(user)) {
    return <div className="empty">Loading…</div>;
  }

  if (!draft) {
    return <div className="empty">Loading board settings…</div>;
  }

  return (
    <div className="settings-page">
      <header className="page-head settings-head">
        <div>
          <h1>Board settings</h1>
          <p className="muted">
            Configure card fields, statuses, dashboard columns, and task progress. Changes apply for
            everyone after Save.
          </p>
        </div>
        <div className="settings-actions">
          <button type="button" className="btn" disabled={!dirty || busy} onClick={revert}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {error && <div className="settings-error" role="alert">{error}</div>}
      {dirty && <div className="settings-dirty">Unsaved changes</div>}

      <div className="settings-layout">
        <div className="settings-editors">
          <nav className="settings-tabs" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-active={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "card" && (
            <CardFieldsEditor
              draft={draft}
              onChange={setDraft}
            />
          )}
          {tab === "statuses" && (
            <StatusesEditor draft={draft} onChange={setDraft} />
          )}
          {tab === "dashboard" && (
            <DashboardEditor draft={draft} onChange={setDraft} />
          )}
          {tab === "kanban" && (
            <KanbanEditor draft={draft} onChange={setDraft} />
          )}
        </div>

        <BoardSettingsPreview document={draft} />
      </div>

      {confirming && (
        <UnsavedChangesPrompt
          creating={false}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
            setPendingHref(null);
          }}
          onDiscard={() => {
            revert();
            setConfirming(false);
            if (pendingHref) router.push(pendingHref);
            setPendingHref(null);
          }}
          onSave={() => {
            void (async () => {
              await save();
              setConfirming(false);
              if (pendingHref) router.push(pendingHref);
              setPendingHref(null);
            })();
          }}
        />
      )}

      {/* Escape hatch for nav clicks while dirty — rail links bypass React router events,
          so we expose a soft leave for the common case via Cancel. */}
      {dirty && (
        <button
          type="button"
          className="settings-leave-hint btn"
          onClick={() => requestLeave("/dashboard")}
        >
          Leave without saving…
        </button>
      )}
    </div>
  );
}

function CardFieldsEditor({
  draft,
  onChange,
}: {
  draft: BoardDocument;
  onChange: (d: BoardDocument) => void;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<CustomFieldType>("text");

  const move = (index: number, dir: -1 | 1) => {
    onChange({ ...draft, cardFields: moveItem(draft.cardFields, index, index + dir) });
  };

  const toggle = (key: string) => {
    onChange({
      ...draft,
      cardFields: draft.cardFields.map((f) =>
        f.key === key && !["po_number", "part_number"].includes(key)
          ? { ...f, visible: !f.visible }
          : f,
      ),
    });
  };

  const addCustom = () => {
    const label = newLabel.trim();
    if (!label) return;
    let key = slugify(label, "cf");
    const used = new Set([
      ...draft.cardFields.map((f) => f.key),
      ...draft.customFields.map((f) => f.key),
    ]);
    let n = 2;
    while (used.has(key)) {
      key = `${slugify(label, "cf")}_${n++}`;
    }
    const custom: CustomFieldConfig = {
      key,
      label,
      type: newType,
      ...(newType === "select" ? { options: ["Option A", "Option B"] } : {}),
    };
    const field: CardFieldConfig = { key, kind: "custom", label, visible: true };
    onChange({
      ...draft,
      customFields: [...draft.customFields, custom],
      cardFields: [...draft.cardFields, field],
    });
    setNewLabel("");
    setNewType("text");
  };

  const removeCustom = (key: string) => {
    onChange({
      ...draft,
      customFields: draft.customFields.filter((f) => f.key !== key),
      cardFields: draft.cardFields.filter((f) => f.key !== key),
    });
  };

  return (
    <section className="settings-panel">
      <p className="muted">
        Reorder and show/hide attributes on the PO card. Removing a custom attribute hides it from
        the UI; values already stored on orders are kept until cleaned separately.
      </p>
      <ul className="settings-list">
        {draft.cardFields.map((f, i) => (
          <li key={f.key}>
            <span className="settings-list-label">
              <b>{f.label}</b>
              <small>{f.kind === "custom" ? `custom · ${f.key}` : "built-in"}</small>
            </span>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={f.visible}
                disabled={f.key === "po_number" || f.key === "part_number"}
                onChange={() => toggle(f.key)}
              />
              Show
            </label>
            <div className="settings-reorder">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button
                type="button"
                disabled={i === draft.cardFields.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
            </div>
            {f.kind === "custom" && (
              <button type="button" className="btn btn-danger" onClick={() => removeCustom(f.key)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="settings-add">
        <h3>Add custom attribute</h3>
        <input
          className="cell-input"
          placeholder="Label"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <select
          className="cell-input"
          value={newType}
          onChange={(e) => setNewType(e.target.value as CustomFieldType)}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="select">Select</option>
        </select>
        <button type="button" className="btn btn-primary" onClick={addCustom} disabled={!newLabel.trim()}>
          Add
        </button>
      </div>
    </section>
  );
}

function StatusesEditor({
  draft,
  onChange,
}: {
  draft: BoardDocument;
  onChange: (d: BoardDocument) => void;
}) {
  const [label, setLabel] = useState("");
  const [tone, setTone] = useState(DEFAULT_TONE_HEX);

  const move = (index: number, dir: -1 | 1) => {
    onChange({ ...draft, statuses: moveItem(draft.statuses, index, index + dir) });
  };

  const update = (key: string, patch: Partial<StatusConfig>) => {
    onChange({
      ...draft,
      statuses: draft.statuses.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });
  };

  const add = () => {
    const name = label.trim();
    if (!name) return;
    let key = slugify(name, "st");
    const used = new Set(draft.statuses.map((s) => s.key));
    let n = 2;
    while (used.has(key)) key = `${slugify(name, "st")}_${n++}`;
    const status: StatusConfig = { key, label: name.toUpperCase(), tone };
    // Park new statuses in the first non-completed column.
    const target =
      draft.kanbanColumns.find((c) => !c.isCompleted) ?? draft.kanbanColumns[0];
    onChange({
      ...draft,
      statuses: [...draft.statuses, status],
      kanbanColumns: draft.kanbanColumns.map((c) =>
        c.key === target?.key ? { ...c, statusKeys: [...c.statusKeys, key] } : c,
      ),
    });
    setLabel("");
  };

  const remove = (key: string) => {
    onChange({
      ...draft,
      statuses: draft.statuses.filter((s) => s.key !== key),
      kanbanColumns: draft.kanbanColumns.map((c) => ({
        ...c,
        statusKeys: c.statusKeys.filter((sk) => sk !== key),
      })),
    });
  };

  return (
    <section className="settings-panel">
      <p className="muted">
        Status catalog for the picker and card footer. Removing a status that any PO still uses is
        blocked on Save.
      </p>
      <ul className="settings-list">
        {draft.statuses.map((s, i) => (
          <li key={s.key}>
            <input
              className="cell-input"
              value={s.label}
              onChange={(e) => update(s.key, { label: e.target.value })}
              aria-label={`Label for ${s.key}`}
            />
            <ToneColorField
              value={s.tone}
              onChange={(hex) => update(s.key, { tone: hex })}
              aria-label={`Color for ${s.label || s.key}`}
            />
            <small className="mono">{s.key}</small>
            <div className="settings-reorder">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                disabled={i === draft.statuses.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </div>
            <button type="button" className="btn btn-danger" onClick={() => remove(s.key)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-add">
        <h3>Add status</h3>
        <input
          className="cell-input"
          placeholder="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <ToneColorField value={tone} onChange={setTone} aria-label="New status color" />
        <button type="button" className="btn btn-primary" disabled={!label.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

function DashboardEditor({
  draft,
  onChange,
}: {
  draft: BoardDocument;
  onChange: (d: BoardDocument) => void;
}) {
  const move = (index: number, dir: -1 | 1) => {
    onChange({
      ...draft,
      dashboardColumns: moveItem(draft.dashboardColumns, index, index + dir),
    });
  };

  const toggle = (key: string) => {
    onChange({
      ...draft,
      dashboardColumns: draft.dashboardColumns.map((c: DashboardColumnConfig) =>
        c.key === key && key !== "job" ? { ...c, visible: !c.visible } : c,
      ),
    });
  };

  return (
    <section className="settings-panel">
      <p className="muted">Choose which dashboard table columns to show and their order.</p>
      <ul className="settings-list">
        {draft.dashboardColumns.map((c, i) => (
          <li key={c.key}>
            <span className="settings-list-label">
              <b>{c.label}</b>
            </span>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={c.visible}
                disabled={c.key === "job"}
                onChange={() => toggle(c.key)}
              />
              Show
            </label>
            <div className="settings-reorder">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button
                type="button"
                disabled={i === draft.dashboardColumns.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KanbanEditor({
  draft,
  onChange,
}: {
  draft: BoardDocument;
  onChange: (d: BoardDocument) => void;
}) {
  const [label, setLabel] = useState("");
  const [tone, setTone] = useState(TONE_HEX.blue);

  const move = (index: number, dir: -1 | 1) => {
    onChange({
      ...draft,
      kanbanColumns: moveItem(draft.kanbanColumns, index, index + dir),
    });
  };

  const update = (key: string, patch: Partial<KanbanColumnConfig>) => {
    onChange({
      ...draft,
      kanbanColumns: draft.kanbanColumns.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    });
  };

  const setCompleted = (key: string) => {
    onChange({
      ...draft,
      kanbanColumns: draft.kanbanColumns.map((c) => ({
        ...c,
        isCompleted: c.key === key,
      })),
    });
  };

  const assignStatus = (statusKey: string, columnKey: string) => {
    onChange({
      ...draft,
      kanbanColumns: draft.kanbanColumns.map((c) => {
        const without = c.statusKeys.filter((sk) => sk !== statusKey);
        if (c.key === columnKey) return { ...c, statusKeys: [...without, statusKey] };
        return { ...c, statusKeys: without };
      }),
    });
  };

  const add = () => {
    const name = label.trim();
    if (!name) return;
    let key = slugify(name, "col");
    const used = new Set(draft.kanbanColumns.map((c) => c.key));
    let n = 2;
    while (used.has(key)) key = `${slugify(name, "col")}_${n++}`;
    // New columns need a status — create a matching status parked there.
    let statusKey = slugify(name, "st");
    const statusUsed = new Set(draft.statuses.map((s) => s.key));
    let sn = 2;
    while (statusUsed.has(statusKey)) statusKey = `${slugify(name, "st")}_${sn++}`;
    onChange({
      ...draft,
      statuses: [...draft.statuses, { key: statusKey, label: name.toUpperCase(), tone }],
      kanbanColumns: [
        ...draft.kanbanColumns,
        {
          key,
          label: name.toUpperCase(),
          tone,
          statusKeys: [statusKey],
          isCompleted: false,
        },
      ],
    });
    setLabel("");
  };

  const remove = (key: string) => {
    const col = draft.kanbanColumns.find((c) => c.key === key);
    if (!col || draft.kanbanColumns.length <= 1) return;
    const fallback = draft.kanbanColumns.find((c) => c.key !== key)!;
    onChange({
      ...draft,
      kanbanColumns: draft.kanbanColumns
        .filter((c) => c.key !== key)
        .map((c) =>
          c.key === fallback.key
            ? { ...c, statusKeys: [...c.statusKeys, ...col.statusKeys] }
            : c,
        ),
    });
  };

  return (
    <section className="settings-panel">
      <p className="muted">
        Progress columns on Task cards. Each status belongs to exactly one column; dragging a card
        into a column sets its status to that column&apos;s first mapped status.
      </p>
      <ul className="settings-list settings-kanban-list">
        {draft.kanbanColumns.map((c, i) => (
          <li key={c.key} className="settings-kanban-item">
            <div className="settings-kanban-head">
              <input
                className="cell-input"
                value={c.label}
                onChange={(e) => update(c.key, { label: e.target.value })}
              />
              <ToneColorField
                value={c.tone}
                onChange={(hex) => update(c.key, { tone: hex })}
                aria-label={`Color for ${c.label || c.key}`}
              />
              <label className="settings-check">
                <input
                  type="radio"
                  name="completed-col"
                  checked={c.isCompleted}
                  onChange={() => setCompleted(c.key)}
                />
                Hide-completed target
              </label>
              <div className="settings-reorder">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === draft.kanbanColumns.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={draft.kanbanColumns.length <= 1}
                onClick={() => remove(c.key)}
              >
                Remove
              </button>
            </div>
            <div className="settings-status-map">
              <span className="muted">Statuses in this column (first = drag default):</span>
              {c.statusKeys.map((sk) => {
                const st = draft.statuses.find((s) => s.key === sk);
                return (
                  <span
                    key={sk}
                    className="settings-status-chip"
                    style={{ ["--tone" as string]: resolveToneColor(st?.tone) }}
                  >
                    {st?.label ?? sk}
                  </span>
                );
              })}
              <label className="settings-map-add">
                Add status
                <select
                  className="cell-input"
                  value=""
                  onChange={(e) => {
                    const sk = e.target.value;
                    if (sk) assignStatus(sk, c.key);
                  }}
                >
                  <option value="">Choose…</option>
                  {draft.statuses
                    .filter((s) => !c.statusKeys.includes(s.key))
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </li>
        ))}
      </ul>
      <div className="settings-add">
        <h3>Add column</h3>
        <input
          className="cell-input"
          placeholder="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <ToneColorField value={tone} onChange={setTone} aria-label="New column color" />
        <button type="button" className="btn btn-primary" disabled={!label.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}
