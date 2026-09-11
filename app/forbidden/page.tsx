import { UserButton } from "@clerk/nextjs";

export default function ForbiddenPage() {
  return (
    <main className="ops-sign-in">
      <section>
        <p>WONE OPERATIONS</p>
        <h1>Administrator access required</h1>
        <span>Your Clerk account is valid, but its production user does not have isAdmin enabled.</span>
        <UserButton />
      </section>
    </main>
  );
}
