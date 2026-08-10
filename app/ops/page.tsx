import OpsDashboard from "../../components/OpsDashboard";
import { getOpsDashboardData } from "../../lib/ops-db";

export const dynamic = "force-dynamic";

function SetupState({ error }: { error: unknown }) {
  return (
    <main className="ops-setup">
      <section>
        <p>WONE OPS</p>
        <h1>Production data is temporarily unavailable.</h1>
        <span>{error instanceof Error ? error.message : String(error)}</span>
      </section>
    </main>
  );
}

export default async function OpsPage() {
  try {
    const data = await getOpsDashboardData();
    return <OpsDashboard data={data} />;
  } catch (error) {
    return <SetupState error={error} />;
  }
}
