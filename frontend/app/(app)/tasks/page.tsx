"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { JobCard } from "@/components/JobCard";
import { PODrawer } from "@/components/PODrawer";
import { api } from "@/lib/api";
import { canEdit, canEditStatus, canModifyStatus, useAuth } from "@/lib/auth";
import { useBoardSettings } from "@/lib/boardSettings";
import { PRIORITY_FIELD_KEY, resolveToneColor, selectionOptions } from "@/lib/boardTypes";
import { captureRects, playFlip, type RectMap } from "@/lib/flip";
import { displayPartIndex, poShowingPart } from "@/lib/parts";
import { useBoardDrag } from "@/lib/useBoardDrag";
import {
  PRIORITY_ORDER,
  type PurchaseOrder,
  type Stage,
  type StageMeta,
  type StatusMeta,
} from "@/lib/types";

type SortKey = "due_asc" | "due_desc" | "priority_desc" | "priority_asc";

/** "board" is the kanban; "cards" is every job in one flat grid. */
type View = "board" | "cards";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "due_asc", label: "Due date · earliest first" },
  { value: "due_desc", label: "Due date · latest first" },
  { value: "priority_desc", label: "Priority · highest first" },
  { value: "priority_asc", label: "Priority · lowest first" },
];

const SORT_STORAGE_KEY = "po_calendar_task_sort";
const VIEW_STORAGE_KEY = "po_calendar_task_view";
const HIDE_COMPLETED_STORAGE_KEY = "po_calendar_task_hide_completed";

/* Zoom is the grid's minimum track width, not a transform: the cards really are
   bigger, so the type stays sharp and the hit targets stay honest. Each step
   drops one column at 1920px — seven cards per row at XS, three at XL. */
const ZOOM_STEPS: { min: string; label: string; density: "s" | "m" | "l" }[] = [
  { min: "18rem", label: "S", density: "s" },
  { min: "22rem", label: "M", density: "m" },
  { min: "26rem", label: "L", density: "l" },
  { min: "32rem", label: "XL", density: "l" },
];

const DEFAULT_ZOOM = 1;
const ZOOM_STORAGE_KEY = "po_calendar_task_zoom_v2";

function priorityRank(priority: string, order: string[]): number {
  const key = priority.toLowerCase();
  const idx = order.findIndex((o) => o.toLowerCase() === key);
  return idx < 0 ? order.length + 1 : idx;
}

const FALLBACK_STAGES: StageMeta[] = [
  { value: "pending", label: "PENDING", tone: "slate", statuses: [] },
  { value: "on_hold", label: "ON HOLD", tone: "orange", statuses: [] },
  { value: "in_progress", label: "IN PROGRESS", tone: "blue", statuses: [] },
  { value: "completed", label: "COMPLETED", tone: "green", statuses: [] },
];

const COLUMN_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

export default function TasksPage() {
  const { user } = useAuth();
  const editable = canEdit(user);
  const canDragStatus = canEditStatus(user);
  const { document, stages: boardStagesMeta, statuses: boardStatuses } = useBoardSettings();

  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "create" | null>(null);
  const [createStage, setCreateStage] = useState<Stage>("pending");
  const [sort, setSort] = useState<SortKey>("due_asc");
  const [view, setView] = useState<View>("board");
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [hideCompleted, setHideCompleted] = useState(false);

  const stages = boardStagesMeta.length ? boardStagesMeta : FALLBACK_STAGES;
  const statuses: StatusMeta[] = boardStatuses;

  const columnOrder = useMemo(
    () => (document?.kanbanColumns ?? []).map((c) => c.key as Stage),
    [document],
  );
  const completedKeys = useMemo(() => {
    const marked = (document?.kanbanColumns ?? [])
      .filter((c) => c.isCompleted)
      .map((c) => c.key);
    return new Set(marked.length ? marked : ["completed"]);
  }, [document]);

  const ORDER = useMemo(
    () =>
      columnOrder.length
        ? columnOrder
        : (["pending", "in_progress", "on_hold", "completed"] as Stage[]),
    [columnOrder],
  );
  const ACTIVE_ORDER = useMemo(
    () => ORDER.filter((s) => !completedKeys.has(s)),
    [ORDER, completedKeys],
  );

  const priorityOrder = useMemo(() => {
    const opts = selectionOptions(document, PRIORITY_FIELD_KEY);
    return opts.length ? opts : PRIORITY_ORDER;
  }, [document]);

  const COMPARATORS = useMemo(() => {
    const rank = (po: PurchaseOrder) => priorityRank(po.priority, priorityOrder);
    return {
      due_asc: (a: PurchaseOrder, b: PurchaseOrder) =>
        a.due_date.localeCompare(b.due_date) || rank(a) - rank(b),
      due_desc: (a: PurchaseOrder, b: PurchaseOrder) =>
        b.due_date.localeCompare(a.due_date) || rank(a) - rank(b),
      priority_desc: (a: PurchaseOrder, b: PurchaseOrder) =>
        rank(a) - rank(b) || a.due_date.localeCompare(b.due_date),
      priority_asc: (a: PurchaseOrder, b: PurchaseOrder) =>
        rank(b) - rank(a) || a.due_date.localeCompare(b.due_date),
    } satisfies Record<SortKey, (a: PurchaseOrder, b: PurchaseOrder) => number>;
  }, [priorityOrder]);

  const boardRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<PurchaseOrder[]>([]);
  const pendingFlip = useRef<RectMap | null>(null);
  const flipSkip = useRef<string | null>(null);
  posRef.current = pos;

  /** snapshot card positions so the next render can animate the difference */
  const rememberLayout = useCallback((skip?: string) => {
    pendingFlip.current = captureRects(boardRef.current);
    flipSkip.current = skip ?? null;
  }, []);

  useLayoutEffect(() => {
    if (!pendingFlip.current) return;
    playFlip(boardRef.current, pendingFlip.current, { skip: flipSkip.current });
    pendingFlip.current = null;
    flipSkip.current = null;
  });

  useEffect(() => {
    const saved = window.localStorage.getItem(SORT_STORAGE_KEY) as SortKey | null;
    if (saved && saved in COMPARATORS) setSort(saved);

    const savedView = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (savedView === "board" || savedView === "cards") setView(savedView);

    const savedZoom = window.localStorage.getItem(ZOOM_STORAGE_KEY);
    if (savedZoom !== null) {
      const level = Number(savedZoom);
      if (Number.isInteger(level) && level >= 0 && level < ZOOM_STEPS.length) setZoom(level);
    }

    const savedHide = window.localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY);
    if (savedHide === "1" || savedHide === "true") setHideCompleted(true);
  }, []);

  const changeSort = (next: SortKey) => {
    rememberLayout();
    setSort(next);
    window.localStorage.setItem(SORT_STORAGE_KEY, next);
  };

  const changeView = (next: View) => {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const changeZoom = (delta: number) => {
    const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, zoom + delta));
    if (next === zoom) return;
    setZoom(next);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
  };

  const changeHideCompleted = (next: boolean) => {
    rememberLayout();
    setHideCompleted(next);
    window.localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, next ? "1" : "0");
  };

  const load = useCallback(async () => {
    setPOs(await api.listPOs(query.trim() ? { q: query.trim() } : {}));
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, PurchaseOrder[]>(ORDER.map((s) => [s, []]));
    for (const po of pos) {
      const bucket = map.get(po.stage) ?? map.get(ORDER[0]);
      bucket?.push(po);
    }
    for (const list of map.values()) list.sort(COMPARATORS[sort]);
    return map;
  }, [pos, sort, ORDER]);

  const boardStages = hideCompleted ? ACTIVE_ORDER : ORDER;

  /** the all-cards view sorts the whole set with the same comparator */
  const allCards = useMemo(() => {
    const list = hideCompleted
      ? pos.filter((p) => !completedKeys.has(p.stage))
      : pos;
    return [...list].sort(COMPARATORS[sort]);
  }, [pos, sort, hideCompleted, completedKeys]);

  const visibleCount =
    view === "board"
      ? boardStages.reduce((n, s) => n + (byStage.get(s)?.length ?? 0), 0)
      : allCards.length;

  /** the board re-sorts behind the drawer; the drawer stays open on the saved card */
  const upsert = (saved: PurchaseOrder) => {
    rememberLayout();
    setPOs((prev) =>
      prev.some((p) => p.id === saved.id)
        ? prev.map((p) => (p.id === saved.id ? saved : p))
        : [...prev, saved],
    );
  };

  const moveTo = useCallback(
    async (stage: Stage, id: string) => {
      const current = posRef.current.find((p) => p.id === id);
      const status = defaultStatusFor(stage);
      let previous: PurchaseOrder[] = [];
      setPOs((prev) => {
        previous = prev;
        return prev.map((p) => (p.id === id ? { ...p, stage } : p));
      });
      try {
        const parts = current?.parts ?? [];
        const saved =
          parts.length > 1
            ? await api.updatePOWithPart(id, null, displayPartIndex(current!), { status })
            : await api.updatePO(id, { stage });
        setPOs((prev) => prev.map((p) => (p.id === id ? saved : p)));
      } catch {
        setPOs(previous);
      }
    },
    [stages],
  );

  /** a locked card holds its column for everyone but an admin; Users may move
   *  unlocked cards (stage), Managers keep the same board drag. */
  const canMove = (po: PurchaseOrder) => canModifyStatus(user, po);

  const { dragging, cardProps, columnProps } = useBoardDrag<Stage>({
    enabled: canDragStatus,
    boardRef,
    // the dragged card is carried by its own clone, so FLIP leaves it alone
    onBeforeDrop: (id) => rememberLayout(id),
    onDrop: (stage, id) => void moveTo(stage, id),
  });

  const defaultStatusFor = (stage: Stage) =>
    stages.find((s) => s.value === stage)?.statuses[0] ?? "need_material_size";

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Task cards</h1>
          <p className="page-sub">
            {visibleCount} jobs{" "}
            {view === "board"
              ? `across ${COLUMN_WORDS[boardStages.length - 1] ?? boardStages.length} columns`
              : "in one grid"}{" "}
            · sorted by {SORTS.find((s) => s.value === sort)?.label.toLowerCase()} ·{" "}
            {view === "board"
              ? "drag a card to move it · hold to grab on touch"
              : `${ZOOM_STEPS[zoom].label} card size`}
          </p>
        </div>
        <div className="head-tools">
          <button type="button" className="btn" onClick={() => window.print()}>
            Print cards
          </button>
          <input
            className="field"
            placeholder="Search job, PO, part, material…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="field"
            value={sort}
            onChange={(e) => changeSort(e.target.value as SortKey)}
            aria-label="Sort cards"
            title={view === "board" ? "Sort cards within each column" : "Sort every card"}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {/* zoom only means something where the grid decides the card width */}
          {view === "cards" && (
            <div
              className="zoom"
              role="group"
              aria-label="Card size"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  changeZoom(-1);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  changeZoom(1);
                }
              }}
            >
              <button
                type="button"
                aria-label="Smaller cards"
                title="Smaller cards"
                aria-disabled={zoom === 0}
                onClick={() => changeZoom(-1)}
              >
                −
              </button>
              <span className="zoom-level" aria-live="polite">
                {ZOOM_STEPS[zoom].label}
              </span>
              <button
                type="button"
                aria-label="Larger cards"
                title="Larger cards"
                aria-disabled={zoom === ZOOM_STEPS.length - 1}
                onClick={() => changeZoom(1)}
              >
                +
              </button>
            </div>
          )}
          <div className="seg">
            <button
              type="button"
              data-active={hideCompleted}
              aria-pressed={hideCompleted}
              title={hideCompleted ? "Show completed work" : "Hide completed work"}
              onClick={() => changeHideCompleted(!hideCompleted)}
            >
              Hide completed
            </button>
          </div>
          <div className="seg">
            <button data-active={view === "board"} onClick={() => changeView("board")}>
              Progress
            </button>
            <button data-active={view === "cards"} onClick={() => changeView("cards")}>
              All cards
            </button>
          </div>
          {editable && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelected(null);
                setCreateStage(ORDER[0] ?? "pending");
                setDrawerMode("create");
              }}
            >
              + New PO
            </button>
          )}
        </div>
      </div>

      {view === "board" ? (
        <div
          className="kanban"
          ref={boardRef}
          data-dragging={dragging !== null}
          style={{ ["--kanban-cols" as string]: String(Math.max(boardStages.length, 1)) }}
        >
          {boardStages.map((stage) => {
            const meta = stages.find((s) => s.value === stage) ?? FALLBACK_STAGES[0];
            const items = byStage.get(stage) ?? [];
            return (
              <section
                key={stage}
                className="kcol"
                style={{ ["--tone" as string]: resolveToneColor(meta.tone) }}
                {...columnProps(stage)}
              >
                <header className="kcol-head">
                  <h2>{meta.label}</h2>
                  <span className="kcount">{items.length}</span>
                  {editable && (
                    <button
                      className="kadd"
                      title={`New PO in ${meta.label}`}
                      onClick={() => {
                        setSelected(null);
                        setCreateStage(stage);
                        setDrawerMode("create");
                      }}
                    >
                      +
                    </button>
                  )}
                </header>

                <div className="kcol-body stagger">
                  {items.map((po, i) => (
                    <div
                      key={po.id}
                      className="kcard"
                      data-grab={canMove(po)}
                      style={{ animationDelay: `${Math.min(i * 26, 200)}ms` }}
                      {...cardProps(po.id, stage, canMove(po))}
                    >
                      <JobCard
                        po={po}
                        onUpdated={upsert}
                        onClick={(face) => {
                          setSelected(face ?? po);
                          setDrawerMode("view");
                        }}
                      />
                    </div>
                  ))}
                  {items.length === 0 && <p className="kempty">Nothing here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <>
          {/* no stage columns here, so no drag handlers: this view only opens cards */}
          <div
            className="board board-all stagger"
            data-zoom={zoom}
            style={{ ["--card-min" as string]: ZOOM_STEPS[zoom].min }}
          >
            {allCards.map((po, i) => (
              <div key={po.id} style={{ animationDelay: `${Math.min(i * 18, 220)}ms` }}>
                <JobCard
                  po={po}
                  density={ZOOM_STEPS[zoom].density}
                  onUpdated={upsert}
                  onClick={(face) => {
                    setSelected(face ?? po);
                    setDrawerMode("view");
                  }}
                />
              </div>
            ))}
          </div>
          {allCards.length === 0 && <div className="empty">No purchase orders match.</div>}
        </>
      )}

      <div className="print-card-sheet" aria-hidden="true">
        {allCards.flatMap((po) => {
          const n = po.parts?.length ?? 0;
          const faces = n > 1 ? po.parts!.map((_, i) => poShowingPart(po, i)) : [po];
          return faces.map((face, i) => (
            <JobCard key={`${po.id}:${i}`} po={face} hideParts />
          ));
        })}
      </div>

      {drawerMode && (
        <PODrawer
          po={selected}
          mode={drawerMode}
          statuses={statuses}
          defaults={{ status: defaultStatusFor(createStage) }}
          onClose={() => {
            setDrawerMode(null);
            setSelected(null);
          }}
          onSaved={upsert}
          onDeleted={(id) => {
            rememberLayout();
            setPOs((prev) => prev.filter((p) => p.id !== id));
            setDrawerMode(null);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}
