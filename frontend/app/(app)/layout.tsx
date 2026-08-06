"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/Brand";
import { canAdministerPeople, canEditBoardSettings, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/calendar", label: "Calendar" },
  { href: "/tasks", label: "Task cards" },
];

/** `/users` is the directory for the ranks that administer accounts and your own
 *  record for everyone else. The rail names it for whichever it is, rather than
 *  hiding it below Manager: self-service name and photo live on that page, so it
 *  has to stay reachable, and calling it "Users" when it shows one person lies.
 *  Settings is Admin-only and omitted from the rail for everyone else. */
const navFor = (user: User | null) => [
  ...NAV,
  { href: "/users", label: canAdministerPeople(user) ? "Users" : "My profile" },
  ...(canEditBoardSettings(user) ? [{ href: "/settings", label: "Settings" }] : []),
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <BrandMark width={120} />
          <div className="brand-sub">TVM Precision Machining</div>
        </div>

        {navFor(user).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="nav-link"
            data-active={pathname.startsWith(item.href)}
          >
            {item.label}
          </Link>
        ))}

        <div className="rail-foot">
          <Avatar initials={user.initials} avatarUrl={user.avatar_url} title={user.name} />
          <div className="rail-user">
            <b>{user.name}</b>
            <small>{user.role}</small>
          </div>
          <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out">
            ⏻
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
