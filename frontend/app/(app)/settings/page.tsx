"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { BoardSettingsPreview } from "@/components/BoardSettingsPreview";
import { UnsavedChangesPrompt } from "@/components/UnsavedChangesPrompt";
import { api } from "@/lib/api";
import { canEditBoardSettings, useAuth } from "@/lib/auth";
import { useBoardSettings } from "@/lib/boardSettings";
import { useListReorder } from "@/lib/useListReorder";
import {
  DEFAULT_TONE_HEX,
  TONE_HEX,
  BUILTIN_SELECT_FIELD_KEYS,
  allowedCardFieldTypes,
  canFilterDashboardColumn,
  isSelectCardField,
  resolveCardFieldType,
  resolveToneColor,
  selectionOptions,
  syncDashboardColumns,
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
  // `#ff0` is a valid 3-digit hex, so echoing the normalised parent value back
  // while the field has focus rewrites "#ff0|000" into "#ffff00" mid-word.
  // Only accept outside changes when the user is not the one typing.
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current) return;
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
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = tryParseToneHex(next);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => {
          editing.current = false;
          setText(resolveToneColor(value));
        }}
      />
    </div>
  );
}

function cloneDoc(doc: BoardDocument): BoardDocument {
  return structuredClone(doc);
}

/** How long text edits are allowed to settle before the preview redraws. */
const PREVIEW_SETTLE_MS = 180;

/** Everything the preview must show back immediately: which nodes exist, in
 *  what order, and their colours (a colour picker with a lag is useless, and
 *  recolouring cannot move anything). Labels, widths and option names are
 *  deliberately absent — those are the edits that reflow the preview. */
function previewStructureKey(doc: BoardDocument | null): string {
  if (!doc) return "";
  return [
    doc.cardFields
      .map((f) => `${f.key}${f.visible ? "+" : "-"}:${resolveCardFieldType(doc, f)}`)
      .join(","),
    doc.customFields.map((f) => `${f.key}:${f.type}`).join(","),
    doc.statuses.map((s) => `${s.key}@${s.tone}`).join(","),
    doc.dashboardColumns
      .map((c) => `${c.key}${c.visible ? "+" : "-"}${c.filterable ? "F" : ""}`)
      .join(","),
    doc.kanbanColumns
      .map((c) => `${c.key}@${c.tone}${c.isCompleted ? "*" : ""}|${c.statusKeys.join("/")}`)
      .join(","),
  ].join(";");
}

/** The preview stays live, but a keystroke no longer reaches it. Structural
 *  edits (toggle, reorder, add, remove) go through immediately so their
 *  animation still lines up with the click; text edits land once typing pauses. */
function usePreviewDocument(draft: BoardDocument | null): BoardDocument | null {
  const [settled, setSettled] = useState<BoardDocument | null>(draft);
  const draftStructure = useMemo(() => previewStructureKey(draft), [draft]);
  const settledStructure = useMemo(() => previewStructureKey(settled), [settled]);

  useEffect(() => {
    if (draft === settled) return;
    if (draftStructure !== settledStructure) {
      setSettled(draft);
      return;
    }
    const timer = window.setTimeout(() => setSettled(draft), PREVIEW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, settled, draftStructure, settledStructure]);

  // Before the first settle there is nothing to show but the draft itself, and
  // an empty column for a frame would shove the whole layout sideways.
  return settled ?? draft;
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
  const [savedAt, setSavedAt] = useState(0);

  // Serialised separately so a keystroke only re-stringifies the draft.
  const draftJson = useMemo(() => JSON.stringify(draft), [draft]);
  const baselineJson = useMemo(() => JSON.stringify(baseline), [baseline]);
  const dirty = draftJson !== baselineJson;
  const previewDocument = usePreviewDocument(draft);

  useEffect(() => {
    if (authLoading) return;
    if (!canEditBoardSettings(user)) {
      router.replace("/dashboard");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!published) return;
    const copy = cloneDoc(published);
    copy.dashboardColumns = syncDashboardColumns(copy);
    setDraft(copy);
    setBaseline(cloneDoc({ ...published, dashboardColumns: syncDashboardColumns(published) }));
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

  useEffect(() => {
    if (!savedAt) return;
    const timer = window.setTimeout(() => setSavedAt(0), 2400);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

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
      setSavedAt(Date.now());
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
    <div className="settings-page" data-dirty={dirty}>
      <header className="page-head settings-head">
        <div>
          <h1>Board settings</h1>
          <p className="muted">
            Configure card fields, select options, statuses, dashboard columns, and task progress.
            Changes apply for everyone after Save.
          </p>
        </div>
      </header>

      {error && <div className="settings-error" role="alert">{error}</div>}

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

        <BoardSettingsPreview document={previewDocument ?? draft} />
      </div>

      {/* Floats over the page only while the draft differs from what is saved,
          so a settled board reserves no room for controls it is not offering.
          Mounted either way: the buttons stay disabled and out of the
          accessibility tree until there is something to act on. */}
      <div className="settings-save-dock" data-dirty={dirty} aria-hidden={!dirty}>
        <span className="settings-dirty" data-dirty={dirty} role="status">
          Unsaved changes
        </span>
        {/* Escape hatch for nav clicks while dirty — rail links bypass React
            router events, so we expose a soft leave next to the actions. */}
        <button
          type="button"
          className="settings-leave-hint btn"
          disabled={!dirty || busy}
          onClick={() => requestLeave("/dashboard")}
        >
          Leave without saving…
        </button>
        <div className="settings-actions">
          <button type="button" className="btn" disabled={!dirty || busy} onClick={revert}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {savedAt > 0 && !dirty && (
        <div className="settings-saved-toast" role="status">
          Settings saved
        </div>
      )}

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
    </div>
  );
}

function setSelectionOptions(
  draft: BoardDocument,
  fieldKey: string,
  options: string[],
): BoardDocument {
  const selectionLists = { ...(draft.selectionLists ?? {}), [fieldKey]: options };
  // Drop legacy top-level catalog once the admin edits options in the new shape.
  const { materialTypes: _legacy, ...rest } = draft;
  void _legacy;
  const next: BoardDocument = { ...rest, selectionLists };
  // Mirror onto custom select definitions only (builtins keep selectionLists alone).
  if (draft.customFields.some((f) => f.key === fieldKey)) {
    next.customFields = draft.customFields.map((f) =>
      f.key === fieldKey && f.type === "select" ? { ...f, options } : f,
    );
  }
  return next;
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const move = (index: number, dir: -1 | 1) => {
    onChange({ ...draft, cardFields: moveItem(draft.cardFields, index, index + dir) });
  };
  const reorder = useListReorder({
    onMove: (from, to) =>
      onChange({ ...draft, cardFields: moveItem(draft.cardFields, from, to) }),
  });

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

  const renameField = (key: string, label: string) => {
    const next: BoardDocument = {
      ...draft,
      cardFields: draft.cardFields.map((f) => (f.key === key ? { ...f, label } : f)),
      customFields: draft.customFields.map((f) => (f.key === key ? { ...f, label } : f)),
      dashboardColumns: draft.dashboardColumns.map((c) =>
        c.key === key ? { ...c, label } : c,
      ),
    };
    onChange(next);
  };

  const setFieldType = (field: CardFieldConfig, nextType: CustomFieldType) => {
    const allowed = allowedCardFieldTypes(draft, field);
    if (!allowed.includes(nextType)) return;
    const wasSelect = resolveCardFieldType(draft, field) === "select";
    const willSelect = nextType === "select";

    let selectionLists = draft.selectionLists ? { ...draft.selectionLists } : undefined;
    if (willSelect && !wasSelect) {
      selectionLists = {
        ...(selectionLists ?? {}),
        [field.key]: selectionLists?.[field.key] ?? [],
      };
    }

    let customFields = draft.customFields;
    let cardFields = draft.cardFields;

    if (field.kind === "custom") {
      customFields = draft.customFields.map((f) => {
        if (f.key !== field.key) return f;
        const updated: CustomFieldConfig = { ...f, type: nextType };
        if (willSelect) {
          updated.options = Array.isArray(f.options)
            ? f.options
            : (selectionLists?.[field.key] ?? []);
        }
        return updated;
      });
      cardFields = draft.cardFields.map((f) =>
        f.key === field.key ? { ...f, label: f.label } : f,
      );
    } else {
      cardFields = draft.cardFields.map((f) =>
        f.key === field.key ? { ...f, type: nextType } : f,
      );
    }

    const next: BoardDocument = {
      ...draft,
      cardFields,
      customFields,
      ...(selectionLists ? { selectionLists } : {}),
    };
    onChange(next);
    if (willSelect && !wasSelect) {
      setExpanded((prev) => ({ ...prev, [field.key]: true }));
    }
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
    const isSelect = newType === "select";
    const custom: CustomFieldConfig = {
      key,
      label,
      type: newType,
      ...(isSelect ? { options: [] } : {}),
    };
    const field: CardFieldConfig = { key, kind: "custom", label, visible: true };
    const selectionLists = isSelect
      ? { ...(draft.selectionLists ?? {}), [key]: [] }
      : draft.selectionLists;
    const next: BoardDocument = {
      ...draft,
      customFields: [...draft.customFields, custom],
      cardFields: [...draft.cardFields, field],
      ...(selectionLists ? { selectionLists } : {}),
    };
    next.dashboardColumns = syncDashboardColumns(next);
    onChange(next);
    if (isSelect) {
      setExpanded((prev) => ({ ...prev, [key]: true }));
    }
    setNewLabel("");
    setNewType("text");
  };

  const removeCustom = (key: string) => {
    const selectionLists = { ...(draft.selectionLists ?? {}) };
    delete selectionLists[key];
    const next: BoardDocument = {
      ...draft,
      customFields: draft.customFields.filter((f) => f.key !== key),
      cardFields: draft.cardFields.filter((f) => f.key !== key),
      selectionLists,
    };
    next.dashboardColumns = syncDashboardColumns(next);
    onChange(next);
  };

  return (
    <section className="settings-panel">
      <p className="muted">
        Rename any field (including built-ins) and change its type within safe bounds. Select
        fields keep choices in a collapsible options list — switching away from select hides the
        picker but keeps the options for later. PO # and Part # stay visible. Removing a custom
        attribute hides it from the UI; values already stored on orders are kept until cleaned
        separately. Removing an option that is still used on orders is blocked.
      </p>
      <ul ref={reorder.rootRef} className="settings-list">
        {draft.cardFields.map((f, i) => {
          const selectField = isSelectCardField(draft, f);
          const fieldType = resolveCardFieldType(draft, f);
          const typeChoices = allowedCardFieldTypes(draft, f);
          const typeLocked = typeChoices.length <= 1;
          const open = expanded[f.key] ?? false;
          return (
            <li
              key={f.key}
              className={selectField ? "settings-field-with-options" : undefined}
              {...reorder.itemProps(f.key, i)}
            >
              <div className="settings-field-main">
                <button
                  type="button"
                  className="settings-drag-handle"
                  {...reorder.handleProps(f.key, i)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <div className="settings-list-label settings-field-identity">
                  <input
                    className="cell-input settings-field-name"
                    value={f.label}
                    onChange={(e) => renameField(f.key, e.target.value)}
                    aria-label={`Name for ${f.key}`}
                    placeholder="Field name"
                  />
                  <small>
                    {f.kind === "custom"
                      ? `custom · ${f.key}`
                      : selectField
                        ? "built-in · select"
                        : "built-in"}
                  </small>
                </div>
                <label className="settings-field-type">
                  <select
                    className="cell-input"
                    value={fieldType}
                    disabled={typeLocked}
                    title={
                      typeLocked
                        ? `${f.label} type is fixed to ${fieldType}`
                        : `Change type for ${f.label}`
                    }
                    aria-label={`Type for ${f.label || f.key}`}
                    onChange={(e) => setFieldType(f, e.target.value as CustomFieldType)}
                  >
                    {typeChoices.map((t) => (
                      <option key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
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
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label="Move up"
                  >
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
                  <button
                    type="button"
                    className="btn btn-danger settings-remove-action"
                    onClick={() => removeCustom(f.key)}
                  >
                    Remove
                  </button>
                )}
              </div>
              {selectField && (
                <div className="settings-options-panel">
                  <button
                    type="button"
                    className="settings-options-toggle"
                    aria-expanded={open}
                    onClick={() => {
                      // The rows below this one are about to move — this is one
                      // of the few non-reorder changes worth animating.
                      reorder.animateNext();
                      setExpanded((prev) => ({ ...prev, [f.key]: !open }));
                    }}
                  >
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span>{f.label || f.key} options</span>
                    <small>{selectionOptions(draft, f.key).length} choices</small>
                  </button>
                  {open && (
                    <SelectOptionsEditor
                      fieldKey={f.key}
                      label={f.label || f.key}
                      options={selectionOptions(draft, f.key)}
                      requireNonEmpty={(BUILTIN_SELECT_FIELD_KEYS as readonly string[]).includes(
                        f.key,
                      )}
                      onChange={(options) =>
                        onChange(setSelectionOptions(draft, f.key, options))
                      }
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
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
  const reorder = useListReorder({
    onMove: (from, to) =>
      onChange({ ...draft, statuses: moveItem(draft.statuses, from, to) }),
  });

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
      <ul ref={reorder.rootRef} className="settings-list">
        {draft.statuses.map((s, i) => (
          <li key={s.key} {...reorder.itemProps(s.key, i)}>
            <button type="button" className="settings-drag-handle" {...reorder.handleProps(s.key, i)}>
              <span aria-hidden="true">⠿</span>
            </button>
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
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button
                type="button"
                disabled={i === draft.statuses.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
            </div>
            <button
              type="button"
              className="btn btn-danger settings-remove-action"
              onClick={() => remove(s.key)}
            >
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
  const columns = useMemo(() => syncDashboardColumns(draft), [draft]);

  const commit = (nextCols: DashboardColumnConfig[]) => {
    onChange({ ...draft, dashboardColumns: nextCols });
  };

  const move = (index: number, dir: -1 | 1) => {
    commit(moveItem(columns, index, index + dir));
  };
  const reorder = useListReorder({
    onMove: (from, to) => commit(moveItem(columns, from, to)),
  });

  const toggle = (key: string) => {
    commit(
      columns.map((c) =>
        c.key === key && key !== "job" ? { ...c, visible: !c.visible } : c,
      ),
    );
  };

  const toggleFilterable = (key: string) => {
    if (!canFilterDashboardColumn(key)) return;
    commit(
      columns.map((c) =>
        c.key === key ? { ...c, filterable: !c.filterable } : c,
      ),
    );
  };

  const setWidth = (key: string, raw: string) => {
    const trimmed = raw.trim();
    let widthRem: number | null = null;
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n > 0) widthRem = Math.round(n * 100) / 100;
      else return;
    }
    commit(columns.map((c) => (c.key === key ? { ...c, widthRem } : c)));
  };

  return (
    <section className="settings-panel">
      <p className="muted">
        Choose which dashboard table columns to show, their order, and width in rem. Leave width
        blank for auto (shares leftover space). Filter marks columns that appear as filter
        controls on the live dashboard (stage pills, or status / priority / customer selects).
        New custom fields and newly available builtins start hidden.
      </p>
      <ul ref={reorder.rootRef} className="settings-list">
        {columns.map((c, i) => (
          <li key={c.key} {...reorder.itemProps(c.key, i)}>
            <button type="button" className="settings-drag-handle" {...reorder.handleProps(c.key, i)}>
              <span aria-hidden="true">⠿</span>
            </button>
            <span className="settings-list-label">
              <b>{c.label}</b>
              <small>{c.key}</small>
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
            {canFilterDashboardColumn(c.key) && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={Boolean(c.filterable)}
                  onChange={() => toggleFilterable(c.key)}
                />
                Filter
              </label>
            )}
            <label className="settings-width">
              <span>Width</span>
              <input
                type="number"
                className="cell-input settings-width-input"
                min={1}
                max={40}
                step={0.25}
                placeholder="auto"
                value={c.widthRem ?? ""}
                aria-label={`${c.label} width in rem`}
                onChange={(e) => {
                  // A half-typed "14." reads back as "" with badInput set. That
                  // is still typing, not a request to fall back to auto width.
                  if (e.target.validity.badInput) return;
                  setWidth(c.key, e.target.value);
                }}
              />
              <span className="settings-width-unit">rem</span>
            </label>
            <div className="settings-reorder">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                ↑
              </button>
              <button
                type="button"
                disabled={i === columns.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
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
  const reorder = useListReorder({
    onMove: (from, to) =>
      onChange({
        ...draft,
        kanbanColumns: moveItem(draft.kanbanColumns, from, to),
      }),
  });

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
      <ul ref={reorder.rootRef} className="settings-list settings-kanban-list">
        {draft.kanbanColumns.map((c, i) => (
          <li
            key={c.key}
            className="settings-kanban-item"
            {...reorder.itemProps(c.key, i)}
          >
            <div className="settings-kanban-head">
              <button type="button" className="settings-drag-handle" {...reorder.handleProps(c.key, i)}>
                <span aria-hidden="true">⠿</span>
              </button>
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
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === draft.kanbanColumns.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  ↓
                </button>
              </div>
              <button
                type="button"
                className="btn btn-danger settings-remove-action"
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

function SelectOptionsEditor({
  fieldKey,
  label,
  options,
  requireNonEmpty,
  onChange,
}: {
  fieldKey: string;
  label: string;
  options: string[];
  requireNonEmpty: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draftLabel, setDraftLabel] = useState("");
  const [filter, setFilter] = useState("");

  const reorder = useListReorder({
    onMove: (from, to) => onChange(moveItem(options, from, to)),
  });

  const filterNeedle = filter.trim().toLowerCase();
  const visibleIndexes = options
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !filterNeedle || m.toLowerCase().includes(filterNeedle))
    .map(({ i }) => i);

  const add = () => {
    const next = draftLabel.trim();
    if (!next) return;
    if (options.some((m) => m.toLowerCase() === next.toLowerCase())) {
      setDraftLabel("");
      return;
    }
    onChange([...options, next]);
    setDraftLabel("");
  };

  const updateAt = (index: number, value: string) => {
    const next = [...options];
    next[index] = value;
    onChange(next);
  };

  const removeAt = (index: number) => {
    if (requireNonEmpty && options.length <= 1) return;
    onChange(options.filter((_, i) => i !== index));
  };

  return (
    <div className="settings-options-editor">
      {options.length > 12 && (
        <div className="settings-add settings-options-filter">
          <input
            className="cell-input"
            placeholder={`Filter ${label.toLowerCase()}…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={`Filter ${label} options`}
          />
        </div>
      )}
      <ul ref={reorder.rootRef} className="settings-list settings-options-list">
        {visibleIndexes.map((i) => {
          const m = options[i];
          const rowKey = `${fieldKey}-opt-${i}`;
          return (
            <li className="settings-option-row" key={rowKey} {...reorder.itemProps(rowKey, i)}>
              <button
                type="button"
                className="settings-drag-handle"
                {...reorder.handleProps(rowKey, i)}
              >
                <span aria-hidden="true">⠿</span>
              </button>
              <input
                className="cell-input settings-option-input"
                value={m}
                onChange={(e) => updateAt(i, e.target.value)}
                aria-label={`${label} option ${i + 1}`}
              />
              <div className="settings-reorder settings-option-controls">
                <button
                  type="button"
                  className="btn"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => onChange(moveItem(options, i, i - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label="Move down"
                  disabled={i === options.length - 1}
                  onClick={() => onChange(moveItem(options, i, i + 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-danger settings-remove-action"
                  aria-label="Remove option"
                  disabled={requireNonEmpty && options.length <= 1}
                  onClick={() => removeAt(i)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {filterNeedle && visibleIndexes.length === 0 && (
        <p className="muted" style={{ margin: "0.5rem 0" }}>
          No options match “{filter.trim()}”.
        </p>
      )}
      {!options.length && (
        <p className="muted" style={{ margin: "0.35rem 0" }}>
          No options yet — add choices below.
        </p>
      )}
      <div className="settings-add settings-option-add">
        <h3>Add option</h3>
        <input
          className="cell-input"
          placeholder="New option"
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!draftLabel.trim()}
          onClick={add}
        >
          Add
        </button>
      </div>
    </div>
  );
}
