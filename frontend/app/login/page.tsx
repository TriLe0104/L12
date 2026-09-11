"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { AuthScreen } from "@/components/AuthScreen";
import { useClawReveal } from "@/components/ClawReveal";
import { LANDING, useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const claw = useClawReveal();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hold = useRef(false);

  useEffect(() => {
    if (!loading && user && !hold.current && !claw.active) router.replace(LANDING);
  }, [loading, user, router, claw.active]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    hold.current = true;
    try {
      await signIn(email.trim(), password);
      claw.arm();
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      router.replace(LANDING);
      await claw.play();
    } catch (err) {
      hold.current = false;
      claw.disarm();
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <form onSubmit={onSubmit} className="auth-form">
        <h2>Sign in</h2>
        <label>
          Email
          <input
            className="field"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint">Accounts are created by an administrator.</p>
      </form>
    </AuthScreen>
  );
}
