"use client";

import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import FullCalendar from "@fullcalendar/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StaffTaskDrawer } from "@/components/StaffTaskDrawer";
import { api } from "@/lib/api";
import { canEdit, useAuth } from "@/lib/auth";
import type { Assignee, StaffTask } from "@/lib/types";

import "./task-calendar.css";

const FILTER_KEY = "po_calendar_task_cal_filter";

type Scope = "everyone" | "mine";

function TaskChip({ task, mine }: { task: StaffTask; mine: boolean }) {
  return (
    <span className="staff-task-chip" data-mine={mine} data-done={task.done}>
      <span className="staff-task-chip-title">{task.title}</span>
      <span className="staff-task-chip-who">{task.assignee.initials}</span>
    </span>
  );
}

export default function TaskCalendarPage() {
  const { user } = useAuth();
  const canAssign = canEdit(user);
  const [tasks, setTasks] = useState<StaffTask[]>([]);
  const [people, setPeople] = useState<Assignee[]>([]);
  const [scope, setScope] = useState<Scope>("everyone");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StaffTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDue, setCreateDue] = useState<string | undefined>();

  useEffect(() => {
    const saved = window.localStorage.getItem(FILTER_KEY);
    if (saved === "mine" || saved === "everyone") setScope(saved);
  }, []);

  const changeScope = (next: Scope) => {
    setScope(next);
    window.localStorage.setItem(FILTER_KEY, next);
  };

  const load = useCallback(async () => {
    const params: Record<string, string | undefined> = {};
    if (query.trim()) params.q = query.trim();
    if (scope === "mine") params.mine = "true";
    setTasks(await api.listStaffTasks(params));
  }, [query, scope]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      load().catch(() => undefined);
    }, 160);
    return () => window.clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!canAssign) return;
    api.assignableUsers().then(setPeople).catch(() => setPeople([]));
  }, [canAssign]);

  const events = useMemo(
    () =>
      tasks.map((task) => ({
        id: task.id,
        start: task.due_date,
        allDay: true,
        title: task.title,
        startEditable: canAssign,
        durationEditable: false,
        extendedProps: { task },
      })),
    [tasks, canAssign],
  );

  const upsert = (saved: StaffTask) => {
    setTasks((prev) =>
      prev.some((row) => row.id === saved.id)
        ? prev.map((row) => (row.id === saved.id ? saved : row))
        : [...prev, saved],
    );
    setSelected(saved);
    setCreating(false);
  };

  const openCreate = (due?: string) => {
    if (!canAssign) return;
    setSelected(null);
    setCreateDue(due);
    setCreating(true);
  };

  const drawerOpen = creating || !!selected;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Task calendar</h1>
          <p className="page-sub">
            {tasks.length} {scope === "mine" ? "assigned to you" : "tasks"} ·{" "}
            {canAssign ? "managers assign people a due date, notes, and a checklist" : "your assignments"}
          </p>
        </div>
        <div className="head-tools">
          <input
            className="field"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="seg">
            <button data-active={scope === "everyone"} onClick={() => changeScope("everyone")}>
              Everyone
            </button>
            <button data-active={scope === "mine"} onClick={() => changeScope("mine")}>
              Mine
            </button>
          </div>
          {canAssign && (
            <button className="btn btn-primary" onClick={() => openCreate()}>
              + New task
            </button>
          )}
        </div>
      </div>

      <div className="calendar-wrap">
        <FullCalendar
          plugins={[dayGridPlugin, listPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,dayGridWeek,listWeek",
          }}
          events={events}
          editable={canAssign}
          eventStartEditable={canAssign}
          height="auto"
          dayMaxEvents={4}
          firstDay={0}
          dateClick={(arg) => {
            if (canAssign) openCreate(arg.dateStr.slice(0, 10));
          }}
          eventContent={(arg) => {
            const task = arg.event.extendedProps.task as StaffTask;
            return <TaskChip task={task} mine={task.assignee.id === user?.id} />;
          }}
          eventClick={(arg) => {
            setCreating(false);
            setSelected(arg.event.extendedProps.task as StaffTask);
          }}
          eventDrop={async (arg) => {
            const task = arg.event.extendedProps.task as StaffTask;
            const due = arg.event.startStr.slice(0, 10);
            try {
              upsert(await api.updateStaffTask(task.id, { due_date: due }));
            } catch {
              arg.revert();
            }
          }}
        />
      </div>

      {drawerOpen && (
        <StaffTaskDrawer
          key={selected?.id ?? `new:${createDue ?? ""}`}
          task={selected}
          defaultDue={createDue}
          people={people}
          onClose={() => {
            setSelected(null);
            setCreating(false);
          }}
          onSaved={upsert}
          onDeleted={(id) => {
            setTasks((prev) => prev.filter((row) => row.id !== id));
            setSelected(null);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}
