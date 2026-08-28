import { BrandLockup } from "./Brand";

export function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="login">
      <section className="login-art">
        <BrandLockup width={280} />
      </section>
      <div className="login-form">{children}</div>
    </main>
  );
}
