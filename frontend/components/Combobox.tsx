"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

const DEFAULT_EMPTY_LABEL = "— select —";

/** Keeps the list on screen when the input sits near the right edge. */
const VIEWPORT_MARGIN = 8;

function findInCatalog(catalog: string[], query: string): string | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  return catalog.find((m) => m.toLowerCase() === needle) ?? null;
}

function allowedSet(options: string[]): Set<string> {
  return new Set(options.map((m) => m.trim().toLowerCase()).filter(Boolean));
}

/**
 * Searchable single-select restricted to the options it is given.
 * Free-typed text that isn't on the list never commits — blur / Escape revert.
 */
export function Combobox({
  value,
  onChange,
  options,
  disabled = false,
  id,
  "aria-label": ariaLabel = "Select",
  placeholder = DEFAULT_EMPTY_LABEL,
  className = "cell-input",
  allowEmpty = true,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  options: string[];
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
  className?: string;
  allowEmpty?: boolean;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const queryRef = useRef("");

  const committed = (value ?? "").trim();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(committed);
  const [highlight, setHighlight] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  queryRef.current = query;

  useEffect(() => {
    if (!open) setQuery(committed);
  }, [committed, open]);

  const catalogOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of options) {
      const t = m.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [options]);

  /* Opening on a committed value shows the box's own text, which as a search
     term would narrow the list to the one row already chosen. Until a key is
     pressed that text is the label, not a query: the whole list stays. */
  const untouched = committed !== "" && query.trim().toLowerCase() === committed.toLowerCase();

  const filtered = useMemo(() => {
    const needle = untouched ? "" : query.trim().toLowerCase();
    if (!needle) return catalogOptions;
    return catalogOptions.filter((m) => m.toLowerCase().includes(needle));
  }, [catalogOptions, query, untouched]);

  const updateCoords = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 180), window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(r.left, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    setCoords({ top: r.bottom + 2, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
    const onScroll = () => updateCoords();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, updateCoords, filtered.length]);

  /* A freshly opened box starts on the row it already holds, so Enter is a
     no-op rather than a silent jump to whatever sorts first. */
  useEffect(() => {
    if (!open) return;
    const current = untouched
      ? filtered.findIndex((m) => m.toLowerCase() === committed.toLowerCase())
      : -1;
    setHighlight(current >= 0 ? current : 0);
  }, [query, open]);

  /* Arrowing past the fold has to bring the row with it — the list scrolls. */
  useEffect(() => {
    if (!open || highlight < 0) return;
    document.getElementById(`${listId}-opt-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, listId]);

  const commitFromQuery = useCallback(() => {
    const trimmed = queryRef.current.trim();
    if (!trimmed) {
      if (allowEmpty) {
        onChange(null);
        setQuery("");
      } else {
        setQuery(committed);
      }
      return;
    }
    const match = findInCatalog(catalogOptions, trimmed);
    if (match) {
      onChange(match);
      setQuery(match);
      return;
    }
    // Unknown free text — never commit.
    setQuery(committed);
  }, [allowEmpty, catalogOptions, committed, onChange]);

  const pick = useCallback(
    (label: string | null) => {
      if (!label) {
        if (allowEmpty) {
          onChange(null);
          setQuery("");
        } else {
          setQuery(committed);
        }
        setOpen(false);
        return;
      }
      const allowed = allowedSet(catalogOptions);
      if (!allowed.has(label.toLowerCase())) {
        setQuery(committed);
        setOpen(false);
        return;
      }
      const canonical = findInCatalog(catalogOptions, label) ?? label;
      onChange(canonical);
      setQuery(canonical);
      setOpen(false);
    },
    [allowEmpty, catalogOptions, committed, onChange],
  );

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      commitFromQuery();
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open, commitFromQuery]);

  /* The reset row is only worth a slot while the box reads as a label rather
     than a search: once there is a query, every row on screen is a match. */
  const showEmptyOption = allowEmpty && (!query.trim() || untouched);
  const lowestIndex = showEmptyOption ? -1 : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((h) => Math.max(h - 1, lowestIndex));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlight < 0 && showEmptyOption) {
        pick(null);
      } else if (open && filtered[highlight]) {
        pick(filtered[highlight]);
      } else {
        commitFromQuery();
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery(committed);
      setOpen(false);
    } else if (e.key === "Tab") {
      commitFromQuery();
      setOpen(false);
    }
  };

  const listbox =
    open && coords && typeof document !== "undefined"
      ? createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="combo-list"
            style={{
              top: coords.top,
              left: coords.left,
              width: coords.width,
            }}
          >
            {showEmptyOption && (
              <li
                id={`${listId}-opt-empty`}
                role="option"
                aria-selected={!committed}
                className={`combo-option combo-empty${highlight < 0 ? " is-active" : ""}`}
                onMouseEnter={() => setHighlight(-1)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(null);
                }}
              >
                {placeholder}
              </li>
            )}
            {filtered.length === 0 ? (
              <li className="combo-empty" role="presentation">
                No matches
              </li>
            ) : (
              filtered.map((m, i) => {
                const selected = committed !== "" && m.toLowerCase() === committed.toLowerCase();
                return (
                  <li
                    key={m}
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={selected}
                    className={`combo-option${i === highlight ? " is-active" : ""}${
                      selected ? " is-selected" : ""
                    }`}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(m);
                    }}
                  >
                    {m}
                  </li>
                );
              })
            )}
          </ul>,
          document.body,
        )
      : null;

  return (
    <div ref={rootRef} className="combo">
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        className={className}
        value={query}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open
            ? highlight < 0 && showEmptyOption
              ? `${listId}-opt-empty`
              : filtered[highlight]
                ? `${listId}-opt-${highlight}`
                : undefined
            : undefined
        }
        onFocus={(e) => {
          if (disabled) return;
          setQuery(committed);
          setOpen(true);
          // typing replaces the committed label instead of appending to it
          e.currentTarget.select();
        }}
        onClick={() => {
          // Escape closes the list without leaving the box; a second click on
          // an already-focused input is the natural way to ask for it back.
          if (!disabled) setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {listbox}
    </div>
  );
}
