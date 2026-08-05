"use client";

import { Avatar } from "@/components/Avatar";
import type { ActivityItem } from "@/lib/types";

function when(iso: string) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ActivityList({
  items,
  emptyLabel = "No activity yet.",
}: {
  items: ActivityItem[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return <p className="kempty">{emptyLabel}</p>;
  }

  return (
    <ul className="timeline">
      {items.map((a) => (
        <li key={a.id}>
          <Avatar
            size="sm"
            initials={a.actor?.initials ?? "SY"}
            avatarUrl={a.actor?.avatar_url}
            title={a.actor?.name ?? "System"}
          />
          <div className="timeline-text">
            <b>{a.action}</b>
            {a.detail && <div className="timeline-detail">{a.detail}</div>}
            <div className="timeline-by">by {a.actor?.name ?? "System"}</div>
          </div>
          <small title={new Date(a.created_at).toLocaleString()}>{when(a.created_at)}</small>
        </li>
      ))}
    </ul>
  );
}
