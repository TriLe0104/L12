"use client";

import { assetUrl } from "@/lib/api";

/** The round person badge: uploaded photo when there is one, initials otherwise. */
export function Avatar({
  initials,
  avatarUrl,
  size,
  title,
  className,
}: {
  initials: string;
  avatarUrl?: string | null;
  /** matches the existing `.avatar.sm` / `.avatar.lg` size modifiers */
  size?: "sm" | "lg";
  title?: string;
  className?: string;
}) {
  const src = assetUrl(avatarUrl);
  const classes = ["avatar", size, className].filter(Boolean).join(" ");

  return (
    <div className={classes} title={title}>
      {src ? (
        // Plain <img>: uploads are served from the API origin, which next/image
        // would only accept with a remotePatterns entry.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={title ?? initials} />
      ) : (
        initials
      )}
    </div>
  );
}
