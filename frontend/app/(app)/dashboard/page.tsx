"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Avatar } from "@/components/Avatar";
import { Combobox } from "@/components/Combobox";
import { CommentBubbleIcon, CommentThread } from "@/components/CommentThread";
import { LockGlyph, PriorityTag, TONE_BY_STATUS, formatDue } from "@/components/JobCard";
import { PODrawer } from "@/components/PODrawer";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import { useBoardSettings } from "@/lib/boardSettings";
import { PRIORITY_FIELD_KEY, dashboardColumnWidthStyle, resolveToneColor, selectionOptions, type DashboardColumnConfig } from "@/lib/boardTypes";
import { customFieldMap } from "@/lib/cardFields";
import { poShowingPart } from "@/lib/parts";
import {
  PRIORITY_ORDER,
  type PurchaseOrder,
  type Stage,
  type StageMeta,
  type StatusMeta,
} from "@/lib/types";

import "./dashboard.css";

function priorityRank(priority: string, order: string[]): number {
  const key = priority.toLowerCase();
  const idx = order.findIndex((o) => o.toLowerCase() === key);
  return idx < 0 ? order.length + 1 : idx;
}

type Dir = "asc" | "desc";

/** What a column sorts on. A number sorts numerically, a string sorts as text,
 *  and `null` marks an empty cell, which sinks to the bottom either way. */
type SortValue = string | number | null;

interface Column {
  key: string;
  label: string;
  /** how the subtitle and the header tooltip name this column */
  noun: string;
  /** right-aligned, mono, tabular — the numeric column at the end of the row */
  numeric?: boolean;
  widthRem?: number | null;
  value: (po: PurchaseOrder, statusRank: Map<string, number>, stageRank: Map<string, number>) => SortValue;
}

/** Process order, mirroring the server's day-one catalog. Only used until
 *  board settings answer. */
const FALLBACK_STATUS_SEQUENCE = [
  "need_material_size",
  "order_material",
  "material_incoming",
  "waiting_setup",
  "running",
  "deburr",
  "inspection",
  "ready_to_plate",
  "ready_to_ship",
];

const FALLBACK_STAGES: StageMeta[] = [
  { value: "pending", label: "PENDING", tone: "slate", statuses: [] },
  { value: "on_hold", label: "ON HOLD", tone: "orange", statuses: [] },
  { value: "in_progress", label: "IN PROGRESS", tone: "blue", statuses: [] },
  { value: "completed", label: "COMPLETED", tone: "green", statuses: [] },
];

const FILTER_STORAGE_KEY = "po_calendar_dashboard_filter";
const FILTERS_STORAGE_KEY = "po_calendar_dashboard_filters_v2";
const SORT_STORAGE_KEY = "po_calendar_dashboard_sort";

type ColumnFilters = {
  stage: string;
  status: string;
  priority: string;
  customer: string;
};

const DEFAULT_COLUMN_FILTERS: ColumnFilters = {
  stage: "all",
  status: "all",
  priority: "all",
  customer: "all",
};

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

type BuiltinColumnDef = Omit<Column, "key" | "label" | "widthRem">;

const BUILTIN_COLUMN_DEFS: Record<string, BuiltinColumnDef> = {
  job: { noun: "job number", value: (po) => po.job_no },
  po_number: { noun: "PO number", value: (po) => po.po_number },
  customer: { noun: "customer", value: (po) => text(po.customer) },
  priority: {
    noun: "priority",
    value: (po) => priorityRank(po.priority, PRIORITY_ORDER),
  },
  stage: {
    noun: "stage",
    value: (po, _sr, stageRank) => stageRank.get(po.stage) ?? 99,
  },
  status: {
    noun: "status",
    value: (po, statusRank) => statusRank.get(po.status) ?? FALLBACK_STATUS_SEQUENCE.length,
  },
  owner: { noun: "owner", value: (po) => text(po.owner?.name) },
  material: { noun: "material", value: (po) => text(poShowingPart(po).material) },
  finish: { noun: "finish", value: (po) => text(poShowingPart(po).finish) },
  certificates: { noun: "certificates", value: (po) => text(poShowingPart(po).certificates) },
  due: { noun: "due date", value: (po) => dayNumber(po.due_date) },
  modified: {
    noun: "when it was last modified",
    value: (po) => (po.last_modified ? Date.parse(po.last_modified.at) : null),
  },
  comments: {
    noun: "comment count",
    value: (po) => po.comment_count ?? 0,
  },
  qty: { noun: "quantity", numeric: true, value: (po) => poShowingPart(po).qty },
  part_number: { noun: "part number", value: (po) => poShowingPart(po).part_number },
  dims: { noun: "dimensions", value: (po) => text(poShowingPart(po).dims) },
  mat_dim: { noun: "material dimensions", value: (po) => text(poShowingPart(po).mat_dim) },
  inspection: { noun: "inspection", value: (po) => text(poShowingPart(po).inspection) },
  hardware: { noun: "hardware", value: (po) => (poShowingPart(po).hardware ? 1 : 0) },
};

const FALLBACK_COLUMNS: Column[] = [
  { key: "job", label: "Job", widthRem: 4.3, ...BUILTIN_COLUMN_DEFS.job },
  { key: "po_number", label: "PO #", widthRem: 4.8, ...BUILTIN_COLUMN_DEFS.po_number },
  { key: "customer", label: "Customer", widthRem: 5.7, ...BUILTIN_COLUMN_DEFS.customer },
  { key: "priority", label: "Priority", widthRem: 5.4, ...BUILTIN_COLUMN_DEFS.priority },
  { key: "stage", label: "Stage", widthRem: 6.7, ...BUILTIN_COLUMN_DEFS.stage },
  { key: "status", label: "Status", widthRem: 8.75, ...BUILTIN_COLUMN_DEFS.status },
  { key: "owner", label: "Owner", widthRem: 5.0, ...BUILTIN_COLUMN_DEFS.owner },
  { key: "material", label: "Material", widthRem: null, ...BUILTIN_COLUMN_DEFS.material },
  { key: "finish", label: "Finish", widthRem: null, ...BUILTIN_COLUMN_DEFS.finish },
  { key: "due", label: "Due", widthRem: 4.3, ...BUILTIN_COLUMN_DEFS.due },
  { key: "modified", label: "Modified", widthRem: 5.4, ...BUILTIN_COLUMN_DEFS.modified },
  { key: "comments", label: "Comments", widthRem: 2.35, ...BUILTIN_COLUMN_DEFS.comments },
  { key: "qty", label: "Qty", widthRem: 3.75, ...BUILTIN_COLUMN_DEFS.qty },
];

const DEFAULT_SORT: { key: string; dir: Dir } = { key: "due", dir: "asc" };

function columnsFromConfig(
  cfg: DashboardColumnConfig[] | undefined,
  customs: ReturnType<typeof customFieldMap>,
  prioOrder: string[],
): Column[] {
  const base = FALLBACK_COLUMNS.map((c) =>
    c.key === "priority"
      ? { ...c, value: (po: PurchaseOrder) => priorityRank(po.priority, prioOrder) }
      : c,
  );
  if (!cfg?.length) return base;
  return cfg
    .filter((c) => c.visible)
    .map((c): Column | null => {
      const builtin = BUILTIN_COLUMN_DEFS[c.key];
      if (builtin) {
        const col: Column = {
          key: c.key,
          label: c.label,
          widthRem: c.widthRem,
          ...builtin,
        };
        if (c.key === "priority") {
          col.value = (po) => priorityRank(po.priority, prioOrder);
        }
        return col;
      }
      const meta = customs.get(c.key);
      return {
        key: c.key,
        label: c.label,
        noun: c.label.toLowerCase(),
        widthRem: c.widthRem,
        numeric: meta?.type === "number",
        value: (po) => {
          const raw = poShowingPart(po).custom_fields?.[c.key];
          if (raw === null || raw === undefined || raw === "") return null;
          if (typeof raw === "number") return raw;
          if (meta?.type === "number") {
            const n = Number(raw);
            return Number.isFinite(n) ? n : String(raw);
          }
          return String(raw);
        },
      };
    })
    .filter((c): c is Column => !!c);
}

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
  const {
    document,
    stages: boardStages,
    statuses: boardStatuses,
    statusByKey,
  } = useBoardSettings();

  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [query, setQuery] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>(DEFAULT_COLUMN_FILTERS);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "create" | null>(null);
  const [commentPoId, setCommentPoId] = useState<string | null>(null);
  const commentAnchorRef = useRef<HTMLButtonElement | null>(null);

  const stages = boardStages.length ? boardStages : FALLBACK_STAGES;
  const statuses: StatusMeta[] = boardStatuses;

  const stageSequence = useMemo(
    () => (document?.kanbanColumns ?? stages).map((c) => ("key" in c ? c.key : c.value) as Stage),
    [document, stages],
  );

  const completedKeys = useMemo(() => {
    const marked = (document?.kanbanColumns ?? [])
      .filter((c) => c.isCompleted)
      .map((c) => c.key);
    return new Set(marked.length ? marked : ["completed"]);
  }, [document]);

  const STAGE_FILTERS = useMemo(() => {
    const ongoing = stageSequence.filter((s) => !completedKeys.has(s) && s !== "on_hold");
    const onHold = stageSequence.filter((s) => s === "on_hold");
    const completed = stageSequence.filter((s) => completedKeys.has(s));
    return [
      { key: "all", label: "All", stages: stageSequence },
      { key: "ongoing", label: "Ongoing", stages: ongoing.length ? ongoing : stageSequence.filter((s) => !completedKeys.has(s)) },
      ...(onHold.length ? [{ key: "on_hold", label: "On hold", stages: onHold }] : []),
      ...(completed.length ? [{ key: "completed", label: "Completed", stages: completed }] : []),
    ];
  }, [stageSequence, completedKeys]);

  const filterableByKey = useMemo(() => {
    const map = new Map<string, boolean>();
    const cols = document?.dashboardColumns ?? [];
    const hasFlag = cols.some((c) => "filterable" in c);
    if (!hasFlag) {
      // Pre-v8 docs (or missing sync) keep the historic filters.
      map.set("stage", true);
      map.set("status", true);
      map.set("priority", true);
      return map;
    }
    for (const c of cols) {
      if (c.filterable) map.set(c.key, true);
    }
    return map;
  }, [document]);

  /** Filter controls follow dashboard column order among enabled ones. */
  const enabledFilterKeys = useMemo(() => {
    const order = ["stage", "status", "priority", "customer"] as const;
    const fromDoc = (document?.dashboardColumns ?? [])
      .map((c) => c.key)
      .filter((k) => filterableByKey.get(k));
    if (fromDoc.length) {
      return fromDoc.filter((k) => (order as readonly string[]).includes(k));
    }
    return order.filter((k) => filterableByKey.get(k));
  }, [document, filterableByKey]);

  const showStageFilter = filterableByKey.get("stage") === true;
  const showStatusFilter = filterableByKey.get("status") === true;
  const showPriorityFilter = filterableByKey.get("priority") === true;
  const showCustomerFilter = filterableByKey.get("customer") === true;

  const priorityOptions = useMemo(() => {
    const opts = selectionOptions(document, PRIORITY_FIELD_KEY);
    return opts.length ? opts : [...PRIORITY_ORDER];
  }, [document]);

  const customerOptions = useMemo(() => {
    const names = new Set<string>();
    for (const po of pos) {
      const name = text(po.customer);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => naturalCompare(a, b));
  }, [pos]);

  const customs = useMemo(() => customFieldMap(document), [document]);

  const visibleColumns = useMemo(() => {
    return columnsFromConfig(document?.dashboardColumns, customs, priorityOptions);
  }, [document, customs, priorityOptions]);

  useEffect(() => {
    let next = { ...DEFAULT_COLUMN_FILTERS };
    try {
      const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ColumnFilters>;
        if (parsed && typeof parsed === "object") {
          next = {
            stage: typeof parsed.stage === "string" ? parsed.stage : "all",
            status: typeof parsed.status === "string" ? parsed.status : "all",
            priority: typeof parsed.priority === "string" ? parsed.priority : "all",
            customer: typeof parsed.customer === "string" ? parsed.customer : "all",
          };
        }
      } else {
        const legacy = window.localStorage.getItem(FILTER_STORAGE_KEY);
        if (legacy) next.stage = legacy;
      }
    } catch {
      /* ignore bad localStorage */
    }
    if (!STAGE_FILTERS.some((f) => f.key === next.stage)) next.stage = "all";
    setColumnFilters(next);

    const savedSort = window.localStorage.getItem(SORT_STORAGE_KEY);
    const [key, dir] = savedSort?.split(":") ?? [];
    if (key && (dir === "asc" || dir === "desc")) setSort({ key, dir });
  }, [STAGE_FILTERS]);

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

  const persistColumnFilters = (next: ColumnFilters) => {
    setColumnFilters(next);
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(next));
    window.localStorage.setItem(FILTER_STORAGE_KEY, next.stage);
  };

  const changeStageFilter = (next: string) => {
    persistColumnFilters({ ...columnFilters, stage: next });
  };

  /** Same column twice reverses it; a new column starts ascending. */
  const toggleSort = (key: string) => {
    const next: { key: string; dir: Dir } =
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

  const stageRank = useMemo(
    () => new Map(stageSequence.map((value, i) => [value, i])),
    [stageSequence],
  );

  const stageMeta = useMemo(
    () => new Map(stages.map((s) => [s.value, s])),
    [stages],
  );

  const activeStageFilter = showStageFilter
    ? (STAGE_FILTERS.find((f) => f.key === columnFilters.stage) ?? STAGE_FILTERS[0])
    : STAGE_FILTERS[0];

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of STAGE_FILTERS) {
      map.set(f.key, pos.filter((po) => f.stages.includes(po.stage)).length);
    }
    return map;
  }, [pos, STAGE_FILTERS]);

  const rows = useMemo(() => {
    const column = visibleColumns.find((c) => c.key === sort.key) ?? visibleColumns[0] ?? FALLBACK_COLUMNS[0];
    const flip = sort.dir === "asc" ? 1 : -1;
    const statusSel = showStatusFilter ? columnFilters.status : "all";
    const prioritySel = showPriorityFilter ? columnFilters.priority : "all";
    const customerSel = showCustomerFilter ? columnFilters.customer : "all";

    return pos
      .filter((po) => activeStageFilter.stages.includes(po.stage))
      .filter((po) => (statusSel === "all" ? true : po.status === statusSel))
      .filter((po) =>
        prioritySel === "all" ? true : po.priority.toLowerCase() === prioritySel.toLowerCase(),
      )
      .filter((po) => (customerSel === "all" ? true : text(po.customer) === customerSel))
      .sort((a, b) => {
        const av = column.value(a, statusRank, stageRank);
        const bv = column.value(b, statusRank, stageRank);
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
  }, [
    pos,
    columnFilters,
    sort,
    statusRank,
    stageRank,
    activeStageFilter,
    visibleColumns,
    showStatusFilter,
    showPriorityFilter,
    showCustomerFilter,
  ]);

  /* Drop stale select values when options disappear or the control is hidden.
     An empty catalog is not evidence that a saved value is gone — statuses and
     customers both arrive a fetch late, and pruning against nothing would clear
     the restored filter before its own options showed up. */
  useEffect(() => {
    setColumnFilters((prev) => {
      let next = prev;
      if (
        showStatusFilter &&
        statuses.length > 0 &&
        prev.status !== "all" &&
        !statuses.some((s) => s.value === prev.status)
      ) {
        next = { ...next, status: "all" };
      }
      if (
        showPriorityFilter &&
        priorityOptions.length > 0 &&
        prev.priority !== "all" &&
        !priorityOptions.some((p) => p.toLowerCase() === prev.priority.toLowerCase())
      ) {
        next = { ...next, priority: "all" };
      }
      if (
        showCustomerFilter &&
        customerOptions.length > 0 &&
        prev.customer !== "all" &&
        !customerOptions.includes(prev.customer)
      ) {
        next = { ...next, customer: "all" };
      }
      if (!showStageFilter && prev.stage !== "all") next = { ...next, stage: "all" };
      if (next !== prev) {
        window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(next));
        window.localStorage.setItem(FILTER_STORAGE_KEY, next.stage);
      }
      return next;
    });
  }, [
    showStageFilter,
    showStatusFilter,
    showPriorityFilter,
    showCustomerFilter,
    statuses,
    priorityOptions,
    customerOptions,
  ]);

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

  const setCommentCount = useCallback((poId: string, count: number) => {
    setPOs((prev) =>
      prev.map((p) => (p.id === poId ? { ...p, comment_count: count } : p)),
    );
  }, []);

  const sortColumn = visibleColumns.find((c) => c.key === sort.key) ?? visibleColumns[0] ?? FALLBACK_COLUMNS[0];

  const priorityLabel = (value: string) =>
    value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value;

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
        {enabledFilterKeys.map((key) => {
          if (key === "stage" && showStageFilter) {
            return (
              <div key="stage" className="dash-filter-group" role="group" aria-label="Stage">
                {STAGE_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className="dash-pill"
                    data-filter={f.key}
                    data-active={columnFilters.stage === f.key}
                    aria-pressed={columnFilters.stage === f.key}
                    onClick={() => changeStageFilter(f.key)}
                  >
                    {f.label}
                    <span className="dash-pill-count">{counts.get(f.key) ?? 0}</span>
                  </button>
                ))}
              </div>
            );
          }
          if (key === "status" && showStatusFilter) {
            return (
              <label key="status" className="dash-filter-field">
                <span className="visually-hidden">Status</span>
                <select
                  className="dash-filter-select"
                  value={columnFilters.status}
                  aria-label="Filter by status"
                  onChange={(e) => persistColumnFilters({ ...columnFilters, status: e.target.value })}
                >
                  <option value="all">All statuses</option>
                  {statuses.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (key === "priority" && showPriorityFilter) {
            return (
              <label key="priority" className="dash-filter-field">
                <span className="visually-hidden">Priority</span>
                <select
                  className="dash-filter-select"
                  value={columnFilters.priority}
                  aria-label="Filter by priority"
                  onChange={(e) =>
                    persistColumnFilters({ ...columnFilters, priority: e.target.value })
                  }
                >
                  <option value="all">All priorities</option>
                  {priorityOptions.map((p) => (
                    <option key={p} value={p}>
                      {priorityLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (key === "customer" && showCustomerFilter) {
            /* A shop's customer list outgrows a drop-down long before the other
               filters do, so this one is typed at rather than scrolled. */
            return (
              <div key="customer" className="dash-filter-field dash-filter-combo">
                <Combobox
                  value={columnFilters.customer === "all" ? null : columnFilters.customer}
                  options={customerOptions}
                  className="dash-filter-input"
                  placeholder="All customers"
                  aria-label="Filter by customer"
                  onChange={(next) =>
                    persistColumnFilters({ ...columnFilters, customer: next ?? "all" })
                  }
                />
              </div>
            );
          }
          return null;
        })}
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
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    data-col={col.key}
                    data-numeric={col.numeric ? "true" : undefined}
                    style={dashboardColumnWidthStyle(col.widthRem)}
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
                      {col.key === "comments" ? (
                        <span className="dash-comments-head" title="Comments">
                          <CommentBubbleIcon />
                          <span className="visually-hidden">Comments</span>
                        </span>
                      ) : (
                        <span>{col.label}</span>
                      )}
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
                    {visibleColumns.map((col) => {
                      const widthStyle = dashboardColumnWidthStyle(col.widthRem);
                      if (col.key === "job") {
                        return (
                          <td key="job" data-col="job" style={widthStyle}>
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
                        );
                      }
                      if (col.key === "po_number") {
                        return (
                          <td key="po_number" data-col="po_number" style={widthStyle}>
                            <span className="dash-mono">{po.po_number}</span>
                          </td>
                        );
                      }
                      if (col.key === "customer") {
                        return (
                          <td
                            key="customer"
                            data-col="customer"
                            style={widthStyle}
                            title={po.customer ?? undefined}
                          >
                            {cell(text(po.customer))}
                          </td>
                        );
                      }
                      if (col.key === "priority") {
                        return (
                          <td key="priority" data-col="priority" style={widthStyle}>
                            <PriorityTag priority={po.priority} label={po.priority_label} />
                          </td>
                        );
                      }
                      if (col.key === "stage") {
                        return (
                          <td key="stage" data-col="stage" style={widthStyle}>
                            {stage ? (
                              <span
                                className="dash-stage"
                                style={{ ["--tone" as string]: resolveToneColor(stage.tone) }}
                              >
                                {stage.label}
                              </span>
                            ) : (
                              EMPTY
                            )}
                          </td>
                        );
                      }
                      if (col.key === "status") {
                        return (
                          <td
                            key="status"
                            data-col="status"
                            style={widthStyle}
                            title={po.status_label}
                          >
                            <span
                              className="dash-status"
                              style={{
                                ["--tone" as string]: resolveToneColor(
                                  statusByKey.get(po.status)?.tone ?? TONE_BY_STATUS[po.status],
                                ),
                              }}
                            >
                              {po.status_label}
                            </span>
                          </td>
                        );
                      }
                      if (col.key === "owner") {
                        return (
                          <td
                            key="owner"
                            data-col="owner"
                            style={widthStyle}
                            title={po.owner?.name ?? undefined}
                          >
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
                        );
                      }
                      if (col.key === "material") {
                        const material = poShowingPart(po).material;
                        return (
                          <td
                            key="material"
                            data-col="material"
                            style={widthStyle}
                            title={material ?? undefined}
                          >
                            {wrapped(text(material))}
                          </td>
                        );
                      }
                      if (col.key === "finish") {
                        const finish = poShowingPart(po).finish;
                        return (
                          <td
                            key="finish"
                            data-col="finish"
                            style={widthStyle}
                            title={finish ?? undefined}
                          >
                            {wrapped(text(finish))}
                          </td>
                        );
                      }
                      if (col.key === "certificates") {
                        const certificates = poShowingPart(po).certificates;
                        return (
                          <td
                            key="certificates"
                            data-col="certificates"
                            style={widthStyle}
                            title={certificates ?? undefined}
                          >
                            {wrapped(text(certificates))}
                          </td>
                        );
                      }
                      if (col.key === "due") {
                        return (
                          <td key="due" data-col="due" style={widthStyle}>
                            <span className="dash-mono" title={po.due_date}>
                              {formatDue(po.due_date)}
                            </span>
                          </td>
                        );
                      }
                      if (col.key === "modified") {
                        return (
                          <td
                            key="modified"
                            data-col="modified"
                            style={widthStyle}
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
                        );
                      }
                      if (col.key === "comments") {
                        return (
                          <td key="comments" data-col="comments" style={widthStyle}>
                            <button
                              type="button"
                              className="dash-comment-btn"
                              data-has={(po.comment_count ?? 0) > 0 ? "true" : "false"}
                              aria-label={
                                (po.comment_count ?? 0) > 0
                                  ? `${po.comment_count} comments on ${po.job_no}`
                                  : `Comments on ${po.job_no}`
                              }
                              aria-expanded={commentPoId === po.id}
                              title="Comments"
                              onClick={(e) => {
                                e.stopPropagation();
                                commentAnchorRef.current = e.currentTarget;
                                setCommentPoId((cur) => (cur === po.id ? null : po.id));
                              }}
                            >
                              <CommentBubbleIcon filled={(po.comment_count ?? 0) > 0} />
                              {(po.comment_count ?? 0) > 0 && (
                                <span className="dash-comment-badge">
                                  {po.comment_count > 99 ? "99+" : po.comment_count}
                                </span>
                              )}
                            </button>
                          </td>
                        );
                      }
                      if (col.key === "qty") {
                        return (
                          <td key="qty" data-col="qty" data-numeric="true" style={widthStyle}>
                            {po.qty}
                          </td>
                        );
                      }
                      if (col.key === "part_number") {
                        return (
                          <td key="part_number" data-col="part_number" style={widthStyle}>
                            <span className="dash-mono">{po.part_number}</span>
                          </td>
                        );
                      }
                      if (col.key === "dims") {
                        return (
                          <td
                            key="dims"
                            data-col="dims"
                            style={widthStyle}
                            title={po.dims ?? undefined}
                          >
                            {wrapped(text(po.dims))}
                          </td>
                        );
                      }
                      if (col.key === "mat_dim") {
                        return (
                          <td
                            key="mat_dim"
                            data-col="mat_dim"
                            style={widthStyle}
                            title={po.mat_dim ?? undefined}
                          >
                            {wrapped(text(po.mat_dim))}
                          </td>
                        );
                      }
                      if (col.key === "inspection") {
                        const label = (po.inspection ?? "").toUpperCase() || null;
                        return (
                          <td key="inspection" data-col="inspection" style={widthStyle}>
                            {cell(label)}
                          </td>
                        );
                      }
                      if (col.key === "hardware") {
                        return (
                          <td key="hardware" data-col="hardware" style={widthStyle}>
                            {po.hardware ? "YES" : "NO"}
                          </td>
                        );
                      }
                      // Custom field column
                      const meta = customs.get(col.key);
                      const raw = poShowingPart(po).custom_fields?.[col.key];
                      const display =
                        raw === null || raw === undefined || raw === ""
                          ? null
                          : String(raw);
                      return (
                        <td
                          key={col.key}
                          data-col={col.key}
                          data-numeric={meta?.type === "number" ? "true" : undefined}
                          style={widthStyle}
                          title={display ?? undefined}
                        >
                          {meta?.type === "number" && display != null
                            ? display
                            : wrapped(display)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <div className="empty">No purchase orders match.</div>}
      </div>

      {commentPoId && (
        <CommentThread
          poId={commentPoId}
          variant="panel"
          anchorEl={commentAnchorRef.current}
          onClose={() => setCommentPoId(null)}
          onCountChange={(count) => setCommentCount(commentPoId, count)}
        />
      )}

      {drawerMode && (
        <PODrawer
          po={selected}
          mode={drawerMode}
          statuses={statuses}
          onClose={() => {
            setDrawerMode(null);
            setSelected(null);
          }}
          onSaved={(saved) => {
            upsert(saved);
            setSelected(saved);
          }}
          onDeleted={(id) => {
            setPOs((prev) => prev.filter((p) => p.id !== id));
            setDrawerMode(null);
            setSelected(null);
          }}
          onCommentCountChange={(poId, count) => setCommentCount(poId, count)}
        />
      )}
    </>
  );
}
