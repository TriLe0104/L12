"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Avatar } from "@/components/Avatar";
import { BrandMark } from "@/components/Brand";
import { canAdministerPeople, useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";

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

const navFor = (user: User | null) => [
  { href: "/cluster", label: "Cluster", icon: <IconCluster /> },
  { href: "/maxlps", label: "MaxLPS", icon: <IconLps /> },
  { href: "/network", label: "Network", icon: <IconNet /> },
  { href: "/provision", label: "Provision", icon: <IconProv /> },
  { href: "/testing", label: "Testing", icon: <IconTest /> },
  { href: "/users", label: canAdministerPeople(user) ? "Users" : "Profile", icon: <IconUser /> },
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
          <BrandMark size={32} />
        </div>

        {navFor(user).map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="nav-link"
            data-active={pathname.startsWith(item.href)}
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
