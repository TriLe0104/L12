"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { Avatar } from "@/components/Avatar";
import { api } from "@/lib/api";
import { canAdministerPeople, useAuth } from "@/lib/auth";
import type { POComment, PurchaseOrder } from "@/lib/types";

import "./CommentThread.css";

function partTag(
  partIndex: number | null | undefined,
  parts?: PurchaseOrder["parts"],
) {
  if (partIndex == null) return "Project";
  const number = parts?.[partIndex]?.part_number;
  return number ? `Part ${partIndex + 1} · ${number}` : `Part ${partIndex + 1}`;
}

function when(iso: string) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function CommentThread({
  poId,
  part,
  parts,
  defaultPart,
  title = "Comments",
  variant = "embedded",
  onCountChange,
  onClose,
  anchorEl,
}: {
  poId: string;
  /** 1-based part number. `"all"` is the dashboard overview. Omit for project chat. */
  part?: number | null | "all";
  parts?: PurchaseOrder["parts"];
  /** 1-based part to tag when posting from the overview. */
  defaultPart?: number;
  title?: string;
  /** Drawer section vs dashboard popover panel. */
  variant?: "embedded" | "panel";
  /** Dashboard badge refresh after post/delete. */
  onCountChange?: (count: number) => void;
  onClose?: () => void;
  /** Panel only: the chat-icon button that opened this thread. */
  anchorEl?: HTMLElement | null;
}) {
  const { user } = useAuth();
  const titleId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [comments, setComments] = useState<POComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listComments(poId, part);
      setComments(rows);
      onCountChange?.(rows.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load comments");
    } finally {
      setLoading(false);
    }
    // onCountChange is a notification, not an input — keep it out of deps so an
    // inline parent callback cannot re-fetch in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poId, part]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loading && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [loading, comments.length]);

  const placePanel = useCallback(() => {
    if (variant !== "panel" || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = Math.min(22 * 16, window.innerWidth - 1.5 * 16);
    const gap = 6;
    let left = r.right - width;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    const below = r.bottom + gap;
    const spaceBelow = window.innerHeight - below;
    const preferUp = spaceBelow < 280 && r.top > spaceBelow;
    setPos(
      preferUp
        ? { position: "fixed", left, bottom: window.innerHeight - r.top + gap, width, maxHeight: Math.min(360, r.top - 24) }
        : { position: "fixed", left, top: below, width, maxHeight: Math.min(360, window.innerHeight - below - 16) },
    );
  }, [variant, anchorEl]);

  useLayoutEffect(() => {
    placePanel();
  }, [placePanel]);

  useEffect(() => {
    if (variant !== "panel") return;
    const onMove = () => placePanel();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [variant, placePanel]);

  useEffect(() => {
    if (variant !== "panel" || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [variant, onClose]);

  useEffect(() => {
    if (variant !== "panel" || !onClose) return;
    const opener = document.activeElement as HTMLElement | null;
    textareaRef.current?.focus();
    return () => opener?.focus?.();
  }, [variant, onClose]);

  async function post() {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.addComment(
        poId,
        trimmed,
        part === "all" ? null : part,
      );
      setComments((prev) => {
        const next = [...prev, created];
        onCountChange?.(next.length);
        return next;
      });
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post");
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: POComment) {
    const mine = comment.actor?.id === user?.id;
    if (!mine && !canAdministerPeople(user)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteComment(poId, comment.id);
      setComments((prev) => {
        const next = prev.filter((c) => c.id !== comment.id);
        onCountChange?.(next.length);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  const thread = (
    <div
      ref={panelRef}
      className={`comment-thread comment-thread--${variant}`}
      style={variant === "panel" ? pos : undefined}
      role={variant === "panel" ? "dialog" : undefined}
      aria-modal={variant === "panel" ? true : undefined}
      aria-labelledby={variant === "panel" ? titleId : undefined}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {variant === "panel" && (
        <header className="comment-thread-head">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="btn" onClick={onClose} aria-label="Close comments">
            Close
          </button>
        </header>
      )}

      <ul ref={listRef} className="comment-thread-list" aria-live="polite">
        {loading && <li className="comment-thread-empty">Loading…</li>}
        {!loading && comments.length === 0 && (
          <li className="comment-thread-empty">No comments yet.</li>
        )}
        {comments.map((c) => {
          const canDelete =
            c.actor?.id === user?.id || canAdministerPeople(user);
          return (
            <li key={c.id} className="comment-bubble">
              <Avatar
                size="sm"
                initials={c.actor?.initials ?? "?"}
                avatarUrl={c.actor?.avatar_url}
                title={c.actor?.name ?? "Former teammate"}
              />
              <div className="comment-bubble-body">
                <div className="comment-bubble-meta">
                  <span className="comment-bubble-name">
                    {c.actor?.name ?? "Former teammate"}
                  </span>
                  {(part === "all" || c.part_index != null) && (
                    <span className="comment-bubble-part">
                      {partTag(c.part_index, parts)}
                    </span>
                  )}
                  <time
                    className="comment-bubble-when"
                    dateTime={c.created_at}
                    title={new Date(c.created_at).toLocaleString()}
                  >
                    {when(c.created_at)}
                  </time>
                  {canDelete && (
                    <button
                      type="button"
                      className="comment-bubble-del"
                      disabled={busy}
                      onClick={() => void remove(c)}
                      title="Delete comment"
                      aria-label="Delete comment"
                    >
                      ×
                    </button>
                  )}
                </div>
                <p className="comment-bubble-text">{c.body}</p>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="error comment-thread-error">{error}</p>}

      <div className="comment-composer">
        <textarea
          ref={textareaRef}
          className="field comment-composer-input"
          rows={2}
          maxLength={2000}
          placeholder="Write a comment…"
          aria-label="Comment"
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void post();
            }
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !body.trim()}
          onClick={() => void post()}
        >
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );

  if (variant === "embedded") return thread;

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="comment-thread-scrim"
        onClick={(e) => {
          e.stopPropagation();
          onClose?.();
        }}
      />
      {thread}
    </>,
    document.body,
  );
}

/** Chat-bubble glyph for the dashboard column and empty states. */
export function CommentBubbleIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      className="comment-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {filled ? (
        <path
          fill="currentColor"
          d="M2.2 2.5h11.6c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H8.4L4.8 14.2V11.3H2.2c-.7 0-1.2-.5-1.2-1.2V3.7c0-.7.5-1.2 1.2-1.2z"
        />
      ) : (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
          d="M2.4 2.8h11.2c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H8.1L5 13.4V10.8H2.4c-.55 0-1-.45-1-1v-6c0-.55.45-1 1-1z"
        />
      )}
    </svg>
  );
}
