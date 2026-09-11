import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const commit = process.argv.includes("--commit");
if (!commit && !process.argv.includes("--dry-run")) throw new Error("Pass --dry-run or --commit.");

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^\uFEFF/, "");
for (const raw of envText.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1).replace(/^["']|["']$/g, "");
}

const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");
if (process.env.DB_HOST_OVERRIDE) url.hostname = process.env.DB_HOST_OVERRIDE;
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const fixes = [
  {
    editionId: "6c6233ac-e9e4-4eb0-8020-9914c5d16ace",
    title: "Jarakabande Eco Ultra 2026",
    location: "Jarakabande Forest, Ramagondanahalli",
    city: "Bengaluru",
    sourceUrl: "https://marathonmitra.com/events/jarakabande-eco-ultra-2026",
  },
  {
    editionId: "e873a9a9-ae44-4cf5-85ae-6b10c6ee6276",
    title: "APR 2025",
    location: "Adarsh Palm Retreat, Devarabisanahalli",
    city: "Bengaluru",
    sourceUrl: "https://aprmarathon.org/",
  },
  {
    editionId: "eeebf8da-a70e-44ac-ac9b-9672cd038dfa",
    title: "BMF Triathlon 2025",
    location: "Vatadahosahalli Lake, Gudibande",
    city: "Gudibande",
    sourceUrl: "https://zenmountain.in/event/bmf-triathlon-2025/",
  },
  {
    editionId: "7bcd6976-4c52-4b07-82fe-24625cc018e4",
    title: "ESPRIT DE CORPS 5K PARENTS' RUN",
    location: "Bengaluru",
    city: "Bengaluru",
    sourceUrl: "https://www.npskrm.com/pdfs/2024-2025/Year-End-Circular-2024-2025.pdf",
  },
  {
    editionId: "487d4584-c72a-4b68-ada8-36b856281c0f",
    title: "Hoysala Hustle 2025",
    location: "NICE Road, Nayandahalli",
    city: "Bengaluru",
    sourceUrl: "https://bhasinsports.com/events/hoysala-hustle-2025/",
  },
  {
    editionId: "fae4b05f-6996-454a-9a85-de8082c6a5cf",
    title: "IRONMAN 70.3 GOA",
    location: "Miramar Beach",
    city: "Panaji",
    sourceUrl: "https://www.ironman.com/races/im703-goa/schedule",
  },
  {
    editionId: "5833d746-5040-45ec-8639-c8d68d2b2144",
    title: "Jarakabande Eco Ultra 2025",
    location: "Jarakabande Forest, Ramagondanahalli",
    city: "Bengaluru",
    sourceUrl: "https://www.capitaltrails.in/trail-races-in-india/jarakabande-eco-run",
  },
  {
    editionId: "cc248fdd-7e8f-4ffe-b45a-16958a43deba",
    title: "JARAKABANDE ECO ULTRA 2024",
    location: "Jarakabande Forest, Ramagondanahalli",
    city: "Bengaluru",
    sourceUrl: "https://www.capitaltrails.in/trail-races-in-india/jarakabande-eco-run",
  },
  {
    editionId: "d8099e9a-08f8-4282-8610-b6265245262b",
    title: "SAP RUN 2024",
    location: "KTPO, Whitefield",
    city: "Bengaluru",
    sourceUrl: "https://www.telugutimes.net/en/bnews/6000-bangaloreans-participate-in-the-first-sap-run-2024-276791.html",
  },
  {
    editionId: "e5917304-98c8-4706-8401-f48a78846282",
    title: "Clarksburg Country Run",
    location: "Clarksburg, California, USA",
    city: "Clarksburg",
    sourceUrl: "https://www.clarksburgcountryrun.com/faq/",
  },
  {
    editionId: "463313de-9efd-41d4-a445-17cbffc3e340",
    title: "One8 Run",
    location: "NICE Road, Bengaluru",
    city: "Bengaluru",
    sourceUrl: "https://thebridge.in/running/one8-run-diverse-turnout-united-running-40850",
  },
  {
    editionId: "e7144d1f-94e4-4485-a5c7-020afb8c4667",
    title: "Tridhaatu Monsoon 10K Run",
    location: "Chembur Gymkhana",
    city: "Mumbai",
    sourceUrl: "https://runindia.in/events/Tridhaatu-Monsoon-10K-Run-2018",
  },
  {
    editionId: "8c720ac0-7ec5-40f1-996d-55410804f15e",
    title: "Kaveri Trail Marathon 2014 ~",
    correctedTitle: "Kaveri Trail Marathon 2014",
    location: "Ranganathittu Bird Sanctuary, Srirangapatna",
    city: "Srirangapatna",
    sourceUrl: "https://www.runsociety.com/news/kaveri-trail-marathon-gives-you-the-chance-to-explore-the-natural-beauty-of-india/",
  },
];

const report = {
  generatedAt: new Date().toISOString(),
  mode: commit ? "commit" : "dry-run",
  editionFixes: [],
  parentRaceFixes: [],
};

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");

  for (const fix of fixes) {
    const current = await client.query(`
      select re.id,re.title,re.location,re.city,re."raceId",r.location as "raceLocation"
      from public.race_editions re join public.races r on r.id=re."raceId"
      where re.id=$1 for update of re,r
    `, [fix.editionId]);
    if (current.rowCount !== 1 || current.rows[0].title !== fix.title) {
      throw new Error(`Edition precondition failed for ${fix.editionId}`);
    }
    const row = current.rows[0];
    if (row.location || row.city) {
      throw new Error(`Location precondition failed for ${fix.title}: existing ${row.location}/${row.city}`);
    }

    const updated = await client.query(`
      update public.race_editions
      set location=$1,city=$2,title=coalesce($4,title)
      where id=$3 and location is null and city is null
    `, [fix.location, fix.city, fix.editionId, fix.correctedTitle ?? null]);
    if (updated.rowCount !== 1) throw new Error(`Edition update failed for ${fix.title}`);
    report.editionFixes.push({ ...fix, raceId: row.raceId, rows: updated.rowCount });

    if (!row.raceLocation && !report.parentRaceFixes.some((item) => item.raceId === row.raceId)) {
      const raceUpdate = await client.query(`update public.races set location=$1 where id=$2 and location is null`, [fix.city, row.raceId]);
      report.parentRaceFixes.push({ raceId: row.raceId, location: fix.city, rows: raceUpdate.rowCount });
    }
  }

  const remaining = await client.query(`
    select count(distinct re.id)::int as count
    from public.race_editions re
    left join public.race_categories rc on rc."raceEditionId"=re.id
    left join public.results res on res."raceCategoryId"=rc.id
    left join public.registrations reg on reg."raceEditionId"=re.id
    left join public.unmatched_race_entries ure on ure."matchedRaceEditionId"=re.id
    where re.location is null and (res.id is not null or reg.id is not null or ure.id is not null)
  `);
  report.remainingDownstreamMissingLocations = remaining.rows[0].count;

  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `result_location_evidence_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
