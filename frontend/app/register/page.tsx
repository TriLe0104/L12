import Link from "next/link";

import { AuthScreen } from "@/components/AuthScreen";

export default function RegisterPage() {
  return (
    <AuthScreen>
      <div className="auth-form">
        <h2>Registration is closed</h2>
        <p className="hint">Only an administrator can create an account.</p>
        <p className="auth-alt">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </AuthScreen>
  );
}
