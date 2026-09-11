import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="ops-sign-in">
      <section>
        <p>WONE OPERATIONS</p>
        <h1>Administrator sign in</h1>
        <span>Use the same WONE account that has administrator access in production.</span>
      </section>
      <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/ops" />
    </main>
  );
}
