"use client";

import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";
import FullCalendar from "@fullcalendar/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { JobCard, JobChip, toneStyle } from "@/components/JobCard";
import { PODrawer } from "@/components/PODrawer";
import { api } from "@/lib/api";
import { canEdit, canModifyPO, useAuth } from "@/lib/auth";
import type { PurchaseOrder, StatusMeta } from "@/lib/types";

type View = "calendar" | "board";

const YEAR_VIEW = "multiMonthYear";

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A year of day cells has no room for a chip, so each job becomes a tone dot. */
function YearDot({ po }: { po: PurchaseOrder }) {
  return (
    <span
      className="year-dot"
      style={toneStyle(po.status)}
      role="img"
      aria-label={`${po.job_no} ${po.po_number}, ${po.status_label}`}
      title={`${po.job_no} · ${po.po_number} · ${po.status_label}`}
    />
  );
}

function enablePopoverCloseKeyboard(eventEl: HTMLElement) {
  const close = eventEl
    .closest<HTMLElement>(".fc-more-popover")
    ?.querySelector<HTMLElement>(".fc-popover-close");
  if (!close || close.dataset.keyboardReady === "true") return;

  close.dataset.keyboardReady = "true";
  close.tabIndex = 0;
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", close.getAttribute("title") || "Close");
}

export default function CalendarPage() {
  const { user } = useAuth();
  const editable = canEdit(user);

  const [pos, setPOs] = useState<PurchaseOrder[]>([]);
  const [statuses, setStatuses] = useState<StatusMeta[]>([]);
  const [view, setView] = useState<View>("calendar");
  const [fcView, setFcView] = useState<string>("dayGridMonth");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState<PurchaseOrder | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "create" | null>(null);

  const load = useCallback(async () => {
    const params: Record<string, string | undefined> = {};
    if (query.trim()) params.q = query.trim();
    if (statusFilter) params.status = statusFilter;
    setPOs(await api.listPOs(params));
  }, [query, statusFilter]);

  useEffect(() => {
    api.statuses().then(setStatuses).catch(() => setStatuses([]));
  }, []);

  useEffect(() => {
    const activatePopoverClose = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(".fc-more-popover .fc-popover-close")) return;
      event.preventDefault();
      target.click();
    };
    document.addEventListener("keydown", activatePopoverClose);
    return () => document.removeEventListener("keydown", activatePopoverClose);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch(() => undefined);
    }, 180);
    return () => clearTimeout(t);
  }, [load]);

  const events = useMemo(
    () =>
      pos.map((po) => ({
        id: po.id,
        start: po.due_date,
        allDay: true,
        title: `${po.job_no} ${po.po_number}`,
        // per-event veto: a locked job keeps its due date unless an admin is
        // signed in, so it must not offer a drag handle to anyone else
        startEditable: canModifyPO(user, po),
        durationEditable: false,
        extendedProps: { po },
      })),
    [pos, user],
  );

  const dueDays = useMemo(() => new Set(pos.map((po) => po.due_date)), [pos]);

  const grouped = useMemo(() => {
    const map = new Map<string, PurchaseOrder[]>();
    for (const po of pos) {
      const list = map.get(po.due_date) ?? [];
      list.push(po);
      map.set(po.due_date, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pos]);

  /** the calendar/board updates behind the drawer; the drawer stays open on the saved card */
  const upsert = (saved: PurchaseOrder) => {
    setPOs((prev) => {
      const exists = prev.some((p) => p.id === saved.id);
      return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved];
    });
  };

  const yearView = view === "calendar" && fcView === YEAR_VIEW;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Shop calendar</h1>
          <p className="page-sub">
            {pos.length} open purchase orders ·{" "}
            {yearView ? "click a day to open that month" : "drag a card to move its due date"}
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
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="seg">
            <button data-active={view === "calendar"} onClick={() => setView("calendar")}>
              Calendar
            </button>
            <button data-active={view === "board"} onClick={() => setView("board")}>
              Cards
            </button>
          </div>
          {editable && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelected(null);
                setDrawerMode("create");
              }}
            >
              + New PO
            </button>
          )}
        </div>
      </div>

      {view === "calendar" ? (
        <div className="calendar-wrap">
          <FullCalendar
            plugins={[dayGridPlugin, listPlugin, multiMonthPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "multiMonthYear,dayGridMonth,dayGridWeek,listWeek",
            }}
            views={{
              multiMonthYear: {
                dayMaxEvents: false,
                multiMonthMaxColumns: 3,
                multiMonthMinWidth: 320,
                fixedWeekCount: false,
                showNonCurrentDates: false,
              },
            }}
            events={events}
            editable={editable && !yearView}
            eventStartEditable={editable && !yearView}
            height="auto"
            dayMaxEvents={4}
            firstDay={0}
            datesSet={(arg) => setFcView(arg.view.type)}
            dayCellClassNames={(arg) =>
              arg.view.type === YEAR_VIEW && dueDays.has(isoDay(arg.date)) ? ["fc-day-has-jobs"] : []
            }
            dateClick={(arg) => {
              if (arg.view.type === YEAR_VIEW) {
                arg.view.calendar.changeView("dayGridMonth", arg.date);
              }
            }}
            eventContent={(arg) => {
              const po = arg.event.extendedProps.po as PurchaseOrder;
              return arg.view.type === YEAR_VIEW ? <YearDot po={po} /> : <JobChip po={po} />;
            }}
            eventDidMount={(arg) => enablePopoverCloseKeyboard(arg.el)}
            eventClick={(arg) => {
              setSelected(arg.event.extendedProps.po as PurchaseOrder);
              setDrawerMode("view");
            }}
            eventDrop={async (arg) => {
              const po = arg.event.extendedProps.po as PurchaseOrder;
              const due = arg.event.startStr.slice(0, 10);
              try {
                upsert(await api.updatePO(po.id, { due_date: due }));
              } catch {
                arg.revert();
              }
            }}
          />
        </div>
      ) : (
        <div>
          {grouped.map(([due, items]) => (
            <section className="board-group" key={due}>
              <div className="board-group-head">
                <h2>
                  {new Date(`${due}T00:00:00`).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </h2>
                <span>{items.length} job(s)</span>
              </div>
              <div className="board stagger">
                {items.map((po, i) => (
                  <div key={po.id} style={{ animationDelay: `${Math.min(i * 28, 200)}ms` }}>
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
            </section>
          ))}
          {grouped.length === 0 && <div className="empty">No purchase orders match.</div>}
        </div>
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
