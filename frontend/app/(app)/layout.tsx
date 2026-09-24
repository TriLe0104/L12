"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/Brand";
import { canAdministerPeople, useAuth } from "@/lib/auth";
import { useUiTheme } from "@/lib/ui-theme";
import type { User } from "@/lib/types";
import "@/app/scc-theme.css";

const IconCluster = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1.2" fill="currentColor" />
    <rect x="14" y="3" width="7" height="7" rx="1.2" fill="currentColor" opacity="0.7" />
    <rect x="3" y="14" width="7" height="7" rx="1.2" fill="currentColor" opacity="0.7" />
    <rect x="14" y="14" width="7" height="7" rx="1.2" fill="currentColor" />
  </svg>
);
const IconNet = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="5" r="2.2" fill="currentColor" />
    <circle cx="5" cy="18" r="2.2" fill="currentColor" />
    <circle cx="19" cy="18" r="2.2" fill="currentColor" />
    <path d="M12 7.2 5.8 16.2M12 7.2l6.2 9" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const IconProv = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v10" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8 9.5 12 13.5 16 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M5 17.5h14v3H5z" fill="currentColor" />
  </svg>
);
const IconLps = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13 2 4 14h7l-1 8 10-14h-7z" fill="currentColor" />
  </svg>
);
const IconTest = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 3h6v2l-1.2 2.2v5.3L18 19.5H6l4.2-7V7.2L9 5z" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
const IconUser = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="8" r="3.2" fill="currentColor" />
    <path d="M5 19c1.2-3.4 3.6-5 7-5s5.8 1.6 7 5" fill="none" stroke="currentColor" strokeWidth="1.7" />
  </svg>
);
const IconGear = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M12 3.5 13.2 6l2.6.4 1.5 2.2-.8 2.5 1.6 2.1-1.6 2.1.8 2.5-1.5 2.2-2.6.4L12 20.5 10.8 18l-2.6-.4-1.5-2.2.8-2.5L5.9 10.8l1.6-2.1-.8-2.5L8.2 6.4l2.6-.4z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
);

const navFor = (user: User | null) => [
  { href: "/cluster", label: "Cluster", icon: <IconCluster /> },
  { href: "/maxlps", label: "Dynamic Power", icon: <IconLps /> },
  { href: "/network", label: "Network", icon: <IconNet /> },
  { href: "/provision", label: "Provision", icon: <IconProv /> },
  { href: "/testing", label: "Testing", icon: <IconTest /> },
  { href: "/settings", label: "Settings", icon: <IconGear /> },
  { href: "/users", label: canAdministerPeople(user) ? "Users" : "Profile", icon: <IconUser /> },
];

const SCC_NAV = new Set(["/cluster", "/maxlps", "/provision", "/settings", "/users"]);

function isSccTheme(theme: string) {
  if (theme === "scc") return true;
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "scc";
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const { theme } = useUiTheme();
  const pathname = usePathname();
  const router = useRouter();
  const items = navFor(user);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user || !isSccTheme(theme)) return;
    if (![...SCC_NAV].some((href) => pathname.startsWith(href))) {
      router.replace("/maxlps");
    }
  }, [theme, user, pathname, router]);

  if (loading || !user) {
    return <div className="empty">Loading…</div>;
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <BrandMark size={32} />
        </div>

        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="nav-link"
            data-active={pathname.startsWith(item.href)}
            data-scc-hide={SCC_NAV.has(item.href) ? undefined : "true"}
            title={item.label}
          >
            <span className="nav-ico">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
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
