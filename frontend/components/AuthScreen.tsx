import { BrandLockup } from "./Brand";

export function AuthScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="login">
      <section className="login-art">
        <BrandLockup width={330} />
        <p>
          TVM Precision Manufacturing LLC, a family run business offers many of the professional
          machine shop services businesses are looking for.
        </p>
      </section>
      <div className="login-form">{children}</div>
    </main>
  );
}
