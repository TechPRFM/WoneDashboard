import AdminDashboard from "../components/AdminDashboard";
import { getDashboardData } from "../lib/db";
import { requireOpsPage } from "../lib/ops-auth";

export const dynamic = "force-dynamic";

function SetupState({ error }: { error: unknown }) {
  return (
    <main className="setup-shell">
      <section className="setup-card">
        <p className="eyebrow">Admin dashboard setup</p>
        <h1>Connect the dashboard to production Postgres</h1>
        <p>
          The app is ready, but it needs a DB connection string in{" "}
          <code>admin-dashboard/.env.local</code>.
        </p>
        <pre>{`DATABASE_URL="postgresql://postgres.fpynisjwugworsctojie:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require"`}</pre>
        <p className="setup-error">{error instanceof Error ? error.message : String(error)}</p>
      </section>
    </main>
  );
}

export default async function Page() {
  await requireOpsPage();
  try {
    const data = await getDashboardData();
    return <AdminDashboard data={data} />;
  } catch (error) {
    return <SetupState error={error} />;
  }
}
