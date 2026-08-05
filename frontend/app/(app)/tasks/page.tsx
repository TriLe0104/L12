"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { JobCard } from "@/components/JobCard";
import { PODrawer } from "@/components/PODrawer";
import { api } from "@/lib/api";
import { canEdit, canModifyPO, useAuth } from "@/lib/auth";
import { captureRects, playFlip, type RectMap } from "@/lib/flip";
import { useBoardDrag } from "@/lib/useBoardDrag";
import {
  PRIORITY_ORDER,
  type PurchaseOrder,
  type Stage,
  type StageMeta,
  type StatusMeta,
} from "@/lib/types";

type SortKey = "due_asc" | "due_desc" | "priority_desc" | "priority_asc";

/** "board" is the four-stage kanban; "cards" is every job in one flat grid. */
type View = "board" | "cards";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "due_asc", label: "Due date · earliest first" },
  { value: "due_desc", label: "Due date · latest first" },
  { value: "priority_desc", label: "Priority · highest first" },
  { value: "priority_asc", label: "Priority · lowest first" },
];

const SORT_STORAGE_KEY = "po_calendar_task_sort";
const VIEW_STORAGE_KEY = "po_calendar_task_view";
const ZOOM_STORAGE_KEY = "po_calendar_task_zoom";

/* Zoom is the grid's minimum track width, not a transform: the cards really are
   bigger, so the type stays sharp and the hit targets stay honest. Each step
   drops one column at 1920px — seven cards per row at XS, three at XL. */
const ZOOM_STEPS: { min: string; label: string }[] = [
  { min: "12rem", label: "XS" },
  { min: "15rem", label: "S" },
  { min: "18rem", label: "M" },
  { min: "23rem", label: "L" },
  { min: "29rem", label: "XL" },
];

const DEFAULT_ZOOM = 2;

const rank = (po: PurchaseOrder) => PRIORITY_ORDER.indexOf(po.priority);

const COMPARATORS: Record<SortKey, (a: PurchaseOrder, b: PurchaseOrder) => number> = {
  due_asc: (a, b) => a.due_date.localeCompare(b.due_date) || rank(a) - rank(b),
  due_desc: (a, b) => b.due_date.localeCompare(a.due_date) || rank(a) - rank(b),
  // ties inside a priority fall back to the soonest due date
  priority_desc: (a, b) => rank(a) - rank(b) || a.due_date.localeCompare(b.due_date),
  priority_asc: (a, b) => rank(b) - rank(a) || a.due_date.localeCompare(b.due_date),
};

const FALLBACK_STAGES: StageMeta[] = [
  { value: "pending", label: "PENDING", tone: "slate", statuses: [] },
  { value: "on_hold", label: "ON HOLD", tone: "orange", statuses: [] },
  { value: "in_progress", label: "IN PROGRESS", tone: "blue", statuses: [] },
  { value: "completed", label: "COMPLETED", tone: "green", statuses: [] },
];

const ORDER: Stage[] = ["pending", "in_progress", "on_hold", "completed"];

export default function TasksPage() {
  const { user } = useAuth();
  const editable = canEdit(user);

  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [stages, setStages] = useState<StageMeta[]>(FALLBACK_STAGES);
  const [statuses, setStatuses] = useState<StatusMeta[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "create" | null>(null);
  const [createStage, setCreateStage] = useState<Stage>("pending");
  const [sort, setSort] = useState<SortKey>("due_asc");
  const [view, setView] = useState<View>("board");
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  const boardRef = useRef<HTMLDivElement>(null);
  const pendingFlip = useRef<RectMap | null>(null);
  const flipSkip = useRef<string | null>(null);

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

  const load = useCallback(async () => {
    setPOs(await api.listPOs(query.trim() ? { q: query.trim() } : {}));
  }, [query]);

  useEffect(() => {
    api.stages().then(setStages).catch(() => setStages(FALLBACK_STAGES));
    api.statuses().then(setStatuses).catch(() => setStatuses([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const byStage = useMemo(() => {
    const map = new Map<Stage, PurchaseOrder[]>(ORDER.map((s) => [s, []]));
    for (const po of pos) map.get(po.stage)?.push(po);
    for (const list of map.values()) list.sort(COMPARATORS[sort]);
    return map;
  }, [pos, sort]);

  /** the all-cards view sorts the whole set with the same comparator */
  const allCards = useMemo(() => [...pos].sort(COMPARATORS[sort]), [pos, sort]);

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
      let previous: PurchaseOrder[] = [];
      setPOs((prev) => {
        previous = prev;
        return prev.map((p) => (p.id === id ? { ...p, stage } : p));
      });
      try {
        const saved = await api.updatePO(id, { stage });
        setPOs((prev) => prev.map((p) => (p.id === id ? saved : p)));
      } catch {
        setPOs(previous);
      }
    },
    [],
  );

  /** a locked card holds its column for everyone but an admin */
  const canMove = (po: PurchaseOrder) => canModifyPO(user, po);

  const { dragging, cardProps, columnProps } = useBoardDrag<Stage>({
    enabled: editable,
    boardRef,
    // the dragged card is carried by its own clone, so FLIP leaves it alone
    onBeforeDrop: (id) => rememberLayout(id),
    onDrop: (stage, id) => void moveTo(stage, id),
  });

  const defaultStatusFor = (stage: Stage) =>
    stages.find((s) => s.value === stage)?.statuses[0] ?? "new";

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Task cards</h1>
          <p className="page-sub">
            {pos.length} jobs {view === "board" ? "across four columns" : "in one grid"} · sorted by{" "}
            {SORTS.find((s) => s.value === sort)?.label.toLowerCase()} ·{" "}
            {view === "board"
              ? "drag a card to move it"
              : `${ZOOM_STEPS[zoom].label} card size`}
          </p>
        </div>
        <div className="head-tools">
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
                setCreateStage("pending");
                setDrawerMode("create");
              }}
            >
              + New PO
            </button>
          )}
        </div>
      </div>

      {view === "board" ? (
        <div className="kanban" ref={boardRef} data-dragging={dragging !== null}>
          {ORDER.map((stage) => {
            const meta = stages.find((s) => s.value === stage) ?? FALLBACK_STAGES[0];
            const items = byStage.get(stage) ?? [];
            return (
              <section
                key={stage}
                className="kcol"
                style={{ ["--tone" as string]: `var(--tone-${meta.tone})` }}
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
                        onClick={() => {
                          setSelected(po);
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
                  onClick={() => {
                    setSelected(po);
                    setDrawerMode("view");
                  }}
                />
              </div>
            ))}
          </div>
          {allCards.length === 0 && <div className="empty">No purchase orders match.</div>}
        </>
      )}

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
