"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Avatar } from "@/components/Avatar";
import { LockGlyph, PriorityTag, TONE_BY_STATUS, formatDue } from "@/components/JobCard";
import { PODrawer } from "@/components/PODrawer";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import {
  PRIORITY_ORDER,
  type POStatus,
  type PurchaseOrder,
  type Stage,
  type StageMeta,
  type StatusMeta,
} from "@/lib/types";

import "./dashboard.css";

type SortKey =
  | "job"
  | "po_number"
  | "customer"
  | "priority"
  | "stage"
  | "status"
  | "owner"
  | "material"
  | "finish"
  | "due"
  | "modified"
  | "qty";

type Dir = "asc" | "desc";

/** What a column sorts on. A number sorts numerically, a string sorts as text,
 *  and `null` marks an empty cell, which sinks to the bottom either way. */
type SortValue = string | number | null;

interface Column {
  key: SortKey;
  label: string;
  /** how the subtitle and the header tooltip name this column */
  noun: string;
  /** right-aligned, mono, tabular — the numeric column at the end of the row */
  numeric?: boolean;
  value: (po: PurchaseOrder, statusRank: Map<string, number>) => SortValue;
}

/** Pipeline order, not alphabetical: sorting by stage should walk the board. */
const STAGE_SEQUENCE: Stage[] = ["pending", "in_progress", "on_hold", "completed"];

/** Process order, mirroring the server's `STATUS_META`. Only used until
 *  `/api/meta/statuses` answers, which is the real source of the sequence. */
const FALLBACK_STATUS_SEQUENCE: POStatus[] = [
  "new",
  "rfq_finishing",
  "in_machining",
  "finishing",
  "under_inspection",
  "wait_vqc",
  "ready_to_ship",
  "shipped",
  "on_hold",
];

const FALLBACK_STAGES: StageMeta[] = [
  { value: "pending", label: "PENDING", tone: "slate", statuses: [] },
  { value: "on_hold", label: "ON HOLD", tone: "orange", statuses: [] },
  { value: "in_progress", label: "IN PROGRESS", tone: "blue", statuses: [] },
  { value: "completed", label: "COMPLETED", tone: "green", statuses: [] },
];

/** The three named buckets partition the four stages, so their counts always
 *  add up to All — whatever the search has narrowed the set to. */
const FILTERS: { key: string; label: string; stages: Stage[] }[] = [
  { key: "all", label: "All", stages: STAGE_SEQUENCE },
  { key: "ongoing", label: "Ongoing", stages: ["pending", "in_progress"] },
  { key: "on_hold", label: "On hold", stages: ["on_hold"] },
  { key: "completed", label: "Completed", stages: ["completed"] },
];

const FILTER_STORAGE_KEY = "po_calendar_dashboard_filter";
const SORT_STORAGE_KEY = "po_calendar_dashboard_sort";

const text = (v: string | null | undefined): string | null => {
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
};

/** `YYYY-MM-DD` as a plain integer, so due dates sort by when they are rather
 *  than by how they spell. */
const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return y * 10000 + m * 100 + d;
};

/** Identifiers carry numbers inside text — J-9 belongs before J-40. */
const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** When a change landed, in the due column's date style plus a clock, because
 *  "who touched this last" is only half an answer without "and when". Same-year
 *  timestamps drop the year to keep the line inside the column. */
const whenModified = (iso: string): string => {
  const at = new Date(iso);
  const year = at.getFullYear();
  const stamp = `${at.getMonth() + 1}/${at.getDate()}`;
  const clock = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  return year === new Date().getFullYear()
    ? `${stamp} ${clock}`
    : `${stamp}/${String(year).slice(2)} ${clock}`;
};

const COLUMNS: Column[] = [
  { key: "job", label: "Job", noun: "job number", value: (po) => po.job_no },
  { key: "po_number", label: "PO #", noun: "PO number", value: (po) => po.po_number },
  { key: "customer", label: "Customer", noun: "customer", value: (po) => text(po.customer) },
  {
    key: "priority",
    label: "Priority",
    noun: "priority",
    value: (po) => PRIORITY_ORDER.indexOf(po.priority),
  },
  {
    key: "stage",
    label: "Stage",
    noun: "stage",
    value: (po) => STAGE_SEQUENCE.indexOf(po.stage),
  },
  {
    key: "status",
    label: "Status",
    noun: "status",
    value: (po, statusRank) => statusRank.get(po.status) ?? FALLBACK_STATUS_SEQUENCE.length,
  },
  { key: "owner", label: "Owner", noun: "owner", value: (po) => text(po.owner?.name) },
  { key: "material", label: "Material", noun: "material", value: (po) => text(po.material) },
  { key: "finish", label: "Finish", noun: "finish", value: (po) => text(po.finish) },
  { key: "due", label: "Due", noun: "due date", value: (po) => dayNumber(po.due_date) },
  {
    key: "modified",
    // "Last modified" set in letter-spaced caps is wider than the column can
    // earn; the subtitle and the header tooltip carry the full sense.
    label: "Modified",
    noun: "when it was last modified",
    // the instant, not the name: scanning this column is about recency
    value: (po) => (po.last_modified ? Date.parse(po.last_modified.at) : null),
  },
  { key: "qty", label: "Qty", noun: "quantity", numeric: true, value: (po) => po.qty },
];

const DEFAULT_SORT: { key: SortKey; dir: Dir } = { key: "due", dir: "asc" };

const isSortKey = (v: string): v is SortKey => COLUMNS.some((c) => c.key === v);

function Caret() {
  return (
    <svg className="dash-caret" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
      <path d="M4 1.3 7.4 6.7H0.6z" fill="currentColor" />
    </svg>
  );
}

const EMPTY = <span className="dash-empty-cell">—</span>;

const cell = (value: string | null): ReactNode => value ?? EMPTY;

/** For the long spec columns: two lines instead of half a word. */
const wrapped = (value: string | null): ReactNode =>
  value ? <span className="dash-clamp">{value}</span> : EMPTY;

export default function DashboardPage() {
  const { user } = useAuth();
  const editable = canEdit(user);

  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [stages, setStages] = useState<StageMeta[]>(FALLBACK_STAGES);
  const [statuses, setStatuses] = useState<StatusMeta[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "create" | null>(null);

  useEffect(() => {
    const savedFilter = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (savedFilter && FILTERS.some((f) => f.key === savedFilter)) setFilter(savedFilter);

    const savedSort = window.localStorage.getItem(SORT_STORAGE_KEY);
    const [key, dir] = savedSort?.split(":") ?? [];
    if (key && isSortKey(key) && (dir === "asc" || dir === "desc")) setSort({ key, dir });
  }, []);

  useEffect(() => {
    api.stages().then(setStages).catch(() => setStages(FALLBACK_STAGES));
    api.statuses().then(setStatuses).catch(() => setStatuses([]));
  }, []);

  /* The search is the server's, same as the task board: it matches job, PO,
     part, material and customer, and everything below counts what came back. */
  const load = useCallback(async () => {
    setPOs(await api.listPOs(query.trim() ? { q: query.trim() } : {}));
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const changeFilter = (next: string) => {
    setFilter(next);
    window.localStorage.setItem(FILTER_STORAGE_KEY, next);
  };

  /** Same column twice reverses it; a new column starts ascending. */
  const toggleSort = (key: SortKey) => {
    const next: { key: SortKey; dir: Dir } =
      sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    setSort(next);
    window.localStorage.setItem(SORT_STORAGE_KEY, `${next.key}:${next.dir}`);
  };

  const statusRank = useMemo(() => {
    const sequence = statuses.length
      ? statuses.map((s) => s.value)
      : FALLBACK_STATUS_SEQUENCE;
    return new Map<string, number>(sequence.map((value, i) => [value, i]));
  }, [statuses]);

  const stageMeta = useMemo(
    () => new Map(stages.map((s) => [s.value, s])),
    [stages],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of FILTERS) {
      map.set(f.key, pos.filter((po) => f.stages.includes(po.stage)).length);
    }
    return map;
  }, [pos]);

  const rows = useMemo(() => {
    const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
    const column = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0];
    const flip = sort.dir === "asc" ? 1 : -1;

    return pos
      .filter((po) => active.stages.includes(po.stage))
      .sort((a, b) => {
        const av = column.value(a, statusRank);
        const bv = column.value(b, statusRank);
        let result: number;
        if (av === null || bv === null) {
          // an empty cell is not "smaller", it is absent: park it at the end
          result = av === bv ? 0 : av === null ? 1 : -1;
        } else if (typeof av === "number" && typeof bv === "number") {
          result = flip * (av - bv);
        } else {
          result = flip * naturalCompare(String(av), String(bv));
        }
        // job number breaks every tie, so the order is never arbitrary
        return result || naturalCompare(a.job_no, b.job_no);
      });
  }, [pos, filter, sort, statusRank]);

  const open = (po: PurchaseOrder) => {
    setSelected(po);
    setDrawerMode("view");
  };

  const upsert = (saved: PurchaseOrder) =>
    setPOs((prev) =>
      prev.some((p) => p.id === saved.id)
        ? prev.map((p) => (p.id === saved.id ? saved : p))
        : [...prev, saved],
    );

  const sortColumn = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[0];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">
            Every purchase order on one sheet · {rows.length} of {pos.length} showing · sorted by{" "}
            {sortColumn.noun}, {sort.dir === "asc" ? "ascending" : "descending"}
          </p>
        </div>
        {editable && (
          <div className="head-tools">
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelected(null);
                setDrawerMode("create");
              }}
            >
              + New PO
            </button>
          </div>
        )}
      </div>

      <div className="dash-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="dash-pill"
            data-filter={f.key}
            data-active={filter === f.key}
            aria-pressed={filter === f.key}
            onClick={() => changeFilter(f.key)}
          >
            {f.label}
            <span className="dash-pill-count">{counts.get(f.key) ?? 0}</span>
          </button>
        ))}
        <input
          className="field dash-search"
          placeholder="Search job, PO, part, material…"
          aria-label="Search purchase orders"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="dash-panel">
        <div className="dash-scroll">
          <table className="dash-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    data-col={col.key}
                    data-numeric={col.numeric ? "true" : undefined}
                    aria-sort={
                      sort.key === col.key
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className="dash-sort"
                      title={`Sort by ${col.noun}`}
                      onClick={() => toggleSort(col.key)}
                    >
                      <span>{col.label}</span>
                      <Caret />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((po) => {
                const stage = stageMeta.get(po.stage);
                return (
                  <tr
                    key={po.id}
                    className="dash-row"
                    data-job={po.job_no}
                    data-locked={po.locked}
                    tabIndex={0}
                    aria-label={`Open ${po.job_no} · ${po.po_number}`}
                    onClick={() => open(po)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(po);
                      }
                    }}
                  >
                    <td data-col="job">
                      <div className="dash-id">
                        <span className="dash-id-job">{po.job_no}</span>
                        {po.locked && (
                          <span
                            className="dash-lock"
                            role="img"
                            aria-label="Locked"
                            title="Locked — only an admin can change it"
                          >
                            <LockGlyph />
                          </span>
                        )}
                      </div>
                      <div className="dash-id-sub">{po.part_number}</div>
                    </td>
                    <td data-col="po_number">
                      <span className="dash-mono">{po.po_number}</span>
                    </td>
                    <td data-col="customer" title={po.customer ?? undefined}>
                      {cell(text(po.customer))}
                    </td>
                    <td data-col="priority">
                      <PriorityTag priority={po.priority} label={po.priority_label} />
                    </td>
                    <td data-col="stage">
                      {stage ? (
                        <span
                          className="dash-stage"
                          style={{ ["--tone" as string]: `var(--tone-${stage.tone})` }}
                        >
                          {stage.label}
                        </span>
                      ) : (
                        EMPTY
                      )}
                    </td>
                    <td data-col="status" title={po.status_label}>
                      <span
                        className="dash-status"
                        style={{
                          ["--tone" as string]: `var(--tone-${TONE_BY_STATUS[po.status] ?? "slate"})`,
                        }}
                      >
                        {po.status_label}
                      </span>
                    </td>
                    <td data-col="owner" title={po.owner?.name ?? undefined}>
                      {po.owner ? (
                        <div className="dash-person">
                          <Avatar
                            size="sm"
                            initials={po.owner.initials}
                            avatarUrl={po.owner.avatar_url}
                            title={po.owner.name}
                          />
                          <span>{po.owner.name}</span>
                        </div>
                      ) : (
                        EMPTY
                      )}
                    </td>
                    <td data-col="material" title={po.material ?? undefined}>
                      {wrapped(text(po.material))}
                    </td>
                    <td data-col="finish" title={po.finish ?? undefined}>
                      {wrapped(text(po.finish))}
                    </td>
                    <td data-col="due">
                      <span className="dash-mono" title={po.due_date}>
                        {formatDue(po.due_date)}
                      </span>
                    </td>
                    <td
                      data-col="modified"
                      title={
                        po.last_modified
                          ? `${po.last_modified.action} by ${po.last_modified.by.name} · ` +
                            new Date(po.last_modified.at).toLocaleString()
                          : "No recorded change to this order"
                      }
                    >
                      {po.last_modified ? (
                        <>
                          <div className="dash-person">
                            <Avatar
                              size="sm"
                              initials={po.last_modified.by.initials}
                              avatarUrl={po.last_modified.by.avatar_url}
                              title={po.last_modified.by.name}
                            />
                            <span>{po.last_modified.by.name}</span>
                          </div>
                          <div className="dash-when">{whenModified(po.last_modified.at)}</div>
                        </>
                      ) : (
                        EMPTY
                      )}
                    </td>
                    <td data-col="qty" data-numeric="true">
                      {po.qty}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <div className="empty">No purchase orders match.</div>}
      </div>

      {drawerMode && (
        <PODrawer
          po={selected}
          mode={drawerMode}
          statuses={statuses}
          onClose={() => {
            setDrawerMode(null);
            setSelected(null);
          }}
          onSaved={upsert}
          onDeleted={(id) => {
            setPOs((prev) => prev.filter((p) => p.id !== id));
            setDrawerMode(null);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}
