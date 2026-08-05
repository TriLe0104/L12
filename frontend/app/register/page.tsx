"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { AuthScreen } from "@/components/AuthScreen";
import { LANDING, useAuth } from "@/lib/auth";

export default function RegisterPage() {
  const { user, loading, signUp } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace(LANDING);
  }, [loading, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    if (password.length < 8) return setError("Use at least 8 characters");

    setBusy(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <form onSubmit={onSubmit} className="auth-form">
        <h2>Create your account</h2>
        <label>
          Full name
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            minLength={2}
          />
        </label>
        <label>
          Email
          <input
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </label>
        <label>
          Confirm password
          <input
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
        <p className="auth-alt">
          Already registered? <Link href="/login">Sign in</Link>
        </p>
        <p className="hint">
          any email works — personal or work
          <br />
          8+ characters, stored as a PBKDF2 hash
        </p>
      </form>
    </AuthScreen>
  );
}
