"use client";

import { Avatar } from "@/components/Avatar";
import { PriorityTag, formatDue, toneStyle } from "@/components/JobCard";
import {
  builtinClass,
  builtinValue,
  customFieldMap,
  customValue,
  visibleCardFields,
} from "@/lib/cardFields";
import type { BoardDocument } from "@/lib/boardTypes";
import { PREVIEW_SAMPLE } from "@/lib/boardTypes";

/** Live preview of card + dashboard headers + kanban, driven by the draft document. */
export function BoardSettingsPreview({ document }: { document: BoardDocument }) {
  const fields = visibleCardFields(document);
  const customs = customFieldMap(document);
  const dashCols = document.dashboardColumns.filter((c) => c.visible);
  const sampleStatus =
    document.statuses.find((s) => s.key === PREVIEW_SAMPLE.status) ?? document.statuses[0];
  const statusKey = sampleStatus?.key ?? "new";
  const statusLabel = sampleStatus?.label ?? "NEW";
  const tone = sampleStatus?.tone ?? "slate";

  const sample = {
    ...PREVIEW_SAMPLE,
    status: statusKey,
    status_label: statusLabel,
    custom_fields: Object.fromEntries(
      document.customFields.map((f) => [
        f.key,
        f.type === "number" ? 12 : f.type === "date" ? "2026-08-15" : f.type === "select" ? (f.options?.[0] ?? "—") : "Sample",
      ]),
    ),
  };

  return (
    <aside className="settings-preview" aria-label="Live preview">
      <header className="settings-preview-head">
        <h2>Preview</h2>
        <p>Sample data — saving does not change real orders.</p>
      </header>

      <section className="settings-preview-block">
        <h3>Card</h3>
        <article className="jobcard settings-preview-card" style={toneStyle(statusKey, tone)}>
          <header className="jobcard-head">
            <div className="jobcard-job">{sample.job_no}</div>
            {sample.priority !== "normal" && (
              <PriorityTag priority={sample.priority} label={sample.priority_label} />
            )}
            <div className="jobcard-due">DUE {formatDue(sample.due_date)}</div>
          </header>
          <div className="jobcard-body">
            <div className="jobcard-thumb">NO IMG</div>
            <dl className="spec">
              {fields.map((f) => (
                <div key={f.key} className="settings-preview-row">
                  <dt>{f.label}</dt>
                  <dd className={f.kind === "builtin" ? builtinClass(f.key, sample) : ""}>
                    {f.kind === "builtin"
                      ? builtinValue(sample, f.key)
                      : customValue(sample, f.key, customs.get(f.key))}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {sample.note && <div className="jobcard-note">{sample.note}</div>}
          <footer className="jobcard-status">
            <span>Status:</span>
            <b>{statusLabel}</b>
            <Avatar initials={sample.owner.initials} avatarUrl={null} title={sample.owner.name} />
          </footer>
        </article>
        <div className="settings-preview-chips" aria-label="Status chips">
          {document.statuses.map((s) => (
            <span
              key={s.key}
              className="settings-status-chip"
              style={{ ["--tone" as string]: `var(--tone-${s.tone})` }}
            >
              {s.label}
            </span>
          ))}
        </div>
      </section>

      <section className="settings-preview-block">
        <h3>Dashboard columns</h3>
        <div className="settings-preview-dash">
          {dashCols.map((c) => (
            <span key={c.key}>{c.label}</span>
          ))}
        </div>
      </section>

      <section className="settings-preview-block">
        <h3>Task progress</h3>
        <div
          className="settings-preview-kanban"
          style={{ ["--cols" as string]: String(Math.max(document.kanbanColumns.length, 1)) }}
        >
          {document.kanbanColumns.map((col) => (
            <div key={col.key} className="settings-preview-kcol">
              <header style={{ ["--tone" as string]: `var(--tone-${col.tone})` }}>
                <b>{col.label}</b>
                {col.isCompleted && <small>completed</small>}
              </header>
              <ul>
                {col.statusKeys.map((sk) => {
                  const st = document.statuses.find((s) => s.key === sk);
                  return <li key={sk}>{st?.label ?? sk}</li>;
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
