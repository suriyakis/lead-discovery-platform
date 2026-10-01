/* eslint-disable no-console */
/**
 * scripts/seed-demo.ts — DEMO / E2E FIXTURE DATA (screenshots, UI audits,
 * Playwright smoke tests). Never point it at a real database.
 *
 * Safety: refuses to run unless DATABASE_URL's database name is exactly
 * `lead_demo` or `lead_e2e`. It TRUNCATEs every table in `public` of that
 * database (RESTART IDENTITY CASCADE) and re-inserts a fixed, deterministic
 * data set whose timestamps are relative to "now" (last ~30 days).
 *
 * Demo logins (team login = email + password; the password comes from
 * SEED_DEMO_PASSWORD, falling back to a local-only default):
 *   demo-admin@example.com    super_admin
 *   demo-member@example.com   member (manager in workspace A)
 *
 * Run from the repo root (inside WSL):
 *   DATABASE_URL=postgres://lead:<pw>@localhost:5432/lead_demo pnpm db:seed-demo
 *
 * All companies, people, domains and phone numbers are invented
 * (*.example.* domains, Ofcom drama-range numbers).
 */

import postgres from 'postgres';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import bcrypt from 'bcryptjs';
import * as s from '../src/lib/db/schema';

// Only ever usable against the throwaway databases allowed below.
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'demo-local-only-password';

// ---------------------------------------------------------------------------
// connection + guard
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (point it at .../lead_demo)');
const dbName = new URL(url).pathname.replace(/^\//, '');
if (dbName !== 'lead_demo' && dbName !== 'lead_e2e') {
  throw new Error(`seed-demo refused: DATABASE_URL targets "${dbName}", not "lead_demo" or "lead_e2e"`);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema: s });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const NOW = new Date();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Date `d` days (+h hours, +m minutes) before now. */
const ago = (d: number, h = 0, m = 0): Date => new Date(NOW.getTime() - d * DAY - h * HOUR - m * MIN);
/** Date `d` days (+h hours) after now. */
const ahead = (d: number, h = 0, m = 0): Date => new Date(NOW.getTime() + d * DAY + h * HOUR + m * MIN);
const plus = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

// Deterministic PRNG so re-runs produce the same data set.
let prngState = 20261001;
function rand(): number {
  prngState |= 0;
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number): number => Math.round(lo + rand() * (hi - lo));
function pick<T>(arr: readonly T[]): T {
  const v = arr[Math.floor(rand() * arr.length)];
  if (v === undefined) throw new Error('pick() on empty array');
  return v;
}
function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}
const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuidish = (): string =>
  `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
const asciiFold = (v: string): string =>
  v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ß/g, 'ss');

const MAIL_DOMAIN = 'northwind-insulation.example.com';
let msgSeq = 0;
const newMessageId = (): string => `<demo.${(++msgSeq).toString().padStart(4, '0')}.${hex(6)}@${MAIL_DOMAIN}>`;

type Country = 'GB' | 'PL' | 'DE' | 'IT';
const COUNTRY_NAME: Record<Country, string> = {
  GB: 'United Kingdom',
  PL: 'Poland',
  DE: 'Germany',
  IT: 'Italy',
};

// ---------------------------------------------------------------------------
// truncate (lead_demo only — guarded above)
// ---------------------------------------------------------------------------

async function truncateAll(): Promise<void> {
  const rows = await client<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' order by tablename`;
  if (rows.length === 0) throw new Error('no tables in lead_demo — run migrations first');
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await client.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  console.log(`truncated ${rows.length} tables in lead_demo`);
}

// ---------------------------------------------------------------------------
// static demo content
// ---------------------------------------------------------------------------

type ProductKey = 'aerogel' | 'wool' | 'sealant';
type RecipeKey = 'uk_aerogel' | 'uk_tenders' | 'pl_facade' | 'de_fire' | 'it_directory';
type Outcome =
  | 'lead'
  | 'new'
  | 'needs_review'
  | 'unverified'
  | 'reject'
  | 'mismatch'
  | 'ignored'
  | 'duplicate'
  | 'archived';
type LeadKey =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7'
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6'
  | 'P1' | 'P2' | 'P3' | 'P4'
  | 'I1' | 'I2'
  | 'Q1' | 'Q2' | 'Q3'
  | 'H1' | 'H2'
  | 'S1'
  | 'X1' | 'X2' | 'X3' | 'X4';

interface CompanySpec {
  name: string;
  domain: string;
  /** Where the company really is (null = no location evidence). */
  country: Country | null;
  city: string | null;
  recipe: RecipeKey;
  /** Which connector run (index into RUN_SPECS) harvested it. */
  run: number;
  outcome: Outcome;
  blurb: string;
  /** Override the recipe's primary product. */
  product?: ProductKey;
  lead?: LeadKey;
  contact?: [first: string, last: string, role: string];
  note?: string;
}

const COMPANIES: CompanySpec[] = [
  // ---------------- run 0: uk_aerogel, 27 days ago ----------------
  { name: 'Solent Marine Insulation Ltd', domain: 'solent-marine.example.co.uk', country: 'GB', city: 'Southampton', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'C4', contact: ['Gareth', 'Pryce', 'Contracts Manager'], blurb: 'Marine and offshore pipe insulation, CUI inspection and lagging repairs for ports and shipyards along the south coast.' },
  { name: 'Teesside Lagging & Cladding Ltd', domain: 'teesside-lagging.example.co.uk', country: 'GB', city: 'Middlesbrough', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'I1', contact: ['Neil', 'Fairbairn', 'Site Operations Manager'], blurb: 'Industrial lagging, cladding and thermal insulation for chemical plants on Teesside. Cryogenic and hot-service pipework.' },
  { name: 'Clydeside Thermal Engineering', domain: 'clydeside-thermal.example.co.uk', country: 'GB', city: 'Glasgow', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'Q1', contact: ['Fiona', 'Gallagher', 'Commercial Manager'], blurb: 'Thermal insulation contractor for distilleries, district heating and process pipework across Scotland.' },
  { name: 'Kent LNG Terminal Services', domain: 'kent-lng-services.example.co.uk', country: 'GB', city: 'Isle of Grain', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'H1', contact: ['Daniel', 'Okafor', 'Maintenance Engineering Lead'], blurb: 'Maintenance and insulation services for LNG import terminal cryogenic lines, including CUI remediation.' },
  { name: 'Grampian Energy Maintenance', domain: 'grampian-energy.example.co.uk', country: 'GB', city: 'Aberdeen', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'S1', contact: ['Ian', 'McLeod', 'Procurement Manager'], blurb: 'Onshore and offshore energy maintenance: insulation, coatings and access for North Sea operators.' },
  { name: 'Brunel Thermal Contracting', domain: 'brunel-thermal.example.co.uk', country: 'GB', city: 'Bristol', recipe: 'uk_aerogel', run: 0, outcome: 'lead', lead: 'X1', contact: ['Tom', 'Ashworth', 'Managing Director'], blurb: 'Pipe and vessel insulation for pharmaceutical and food plants in the South West. Space-constrained retrofits a speciality.' },
  { name: 'Northsea Pipe Insulation Ltd', domain: 'northsea-pipeinsulation.example.co.uk', country: 'GB', city: 'Aberdeen', recipe: 'uk_aerogel', run: 0, outcome: 'new', contact: ['Rebecca', 'Thornton', 'Head of Procurement'], blurb: 'Pipe insulation and heat tracing for oil & gas, including subsea spools and topside CUI programmes.' },
  { name: 'Mersey Mechanical Insulation', domain: 'mersey-mech-insulation.example.co.uk', country: 'GB', city: 'Liverpool', recipe: 'uk_aerogel', run: 0, outcome: 'needs_review', blurb: 'Mechanical services insulation for commercial buildings and some light industrial work in the North West.' },
  { name: 'Severn Industrial Coatings & Insulation', domain: 'severn-ici.example.co.uk', country: 'GB', city: 'Newport', recipe: 'uk_aerogel', run: 0, outcome: 'new', blurb: 'Coatings, fireproofing and thermal insulation for steelworks and refineries in South Wales.' },
  { name: 'Home Loft Insulation Direct', domain: 'loft-direct.example.co.uk', country: 'GB', city: 'Reading', recipe: 'uk_aerogel', run: 0, outcome: 'reject', blurb: 'Residential loft and cavity wall insulation installers. Free quotes for homeowners, grant-funded schemes.' },
  { name: 'InsulationShop UK', domain: 'insulationshop.example.co.uk', country: 'GB', city: 'Leicester', recipe: 'uk_aerogel', run: 0, outcome: 'reject', blurb: 'Online shop selling insulation boards, rolls and tapes to DIY customers and small builders. Next-day delivery.' },
  { name: 'Ostsee LNG Terminal Services GmbH', domain: 'ostsee-lng.example.de', country: 'DE', city: 'Rostock', recipe: 'uk_aerogel', run: 0, outcome: 'mismatch', blurb: 'Kryotechnische Isolierung und Wartung für LNG-Terminals an der Ostseeküste, Rostock.' },
  { name: 'Pfalz Chemiepark Wartung GmbH', domain: 'pfalz-chemiepark.example.de', country: 'DE', city: 'Ludwigshafen', recipe: 'uk_aerogel', run: 0, outcome: 'mismatch', blurb: 'Instandhaltung, Isolierung und Gerüstbau im Chemiepark Ludwigshafen.' },

  // ---------------- run 1: pl_facade, 24 days ago ----------------
  { name: 'Termo-Izol Gdańsk S.A.', domain: 'termoizol-gdansk.example.pl', country: 'PL', city: 'Gdańsk', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'C2', contact: ['Tomasz', 'Wiśniewski', 'Kierownik zakupów'], blurb: 'Generalny wykonawca izolacji przemysłowych i fasad wentylowanych na Pomorzu. Obiekty logistyczne i portowe.' },
  { name: 'Budmax Fasady Sp. z o.o.', domain: 'budmax-fasady.example.pl', country: 'PL', city: 'Warszawa', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'P2', contact: ['Agnieszka', 'Zielińska', 'Dyrektor techniczna'], blurb: 'Projektowanie i montaż fasad wentylowanych oraz systemów ociepleń dla biurowców w Warszawie.' },
  { name: 'Przemysłowe Izolacje Termiczne PIT', domain: 'pit-izolacje.example.pl', country: 'PL', city: 'Płock', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'Q2', contact: ['Krzysztof', 'Mazur', 'Główny technolog'], blurb: 'Izolacje termiczne instalacji przemysłowych i przegród budynków technicznych w rejonie Płocka.' },
  { name: 'Polskie Centra Danych Budowa', domain: 'pcd-budowa.example.pl', country: 'PL', city: 'Warszawa', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'H2', contact: ['Paweł', 'Kamiński', 'Prezes zarządu'], blurb: 'Budowa i rozbudowa centrów danych: obudowy, ściany ogniowe, przegrody o podwyższonej odporności ogniowej.' },
  { name: 'Izolbud Śląsk Sp. z o.o.', domain: 'izolbud-slask.example.pl', country: 'PL', city: 'Katowice', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'X3', contact: ['Marek', 'Dąbrowski', 'Kierownik budowy'], blurb: 'Docieplenia budynków przemysłowych i hal magazynowych na Śląsku, płyty warstwowe i wełna mineralna.' },
  { name: 'Hydro-Term Instalacje', domain: 'hydroterm.example.pl', country: 'PL', city: 'Łódź', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'R2', contact: ['Ewa', 'Kaczmarek', 'Specjalistka ds. zaopatrzenia'], blurb: 'Instalacje HVAC i izolacje kanałów wentylacyjnych dla obiektów komercyjnych w Łodzi.' },
  { name: 'Lubelskie Systemy Elewacyjne', domain: 'lse-elewacje.example.pl', country: 'PL', city: 'Lublin', recipe: 'pl_facade', run: 1, outcome: 'lead', lead: 'R7', contact: ['Joanna', 'Wójcik', 'Kierownik projektu'], blurb: 'Fasady wentylowane i ocieplenia z wełny mineralnej dla budynków użyteczności publicznej.' },
  { name: 'Elewacje Nowak Sp. z o.o.', domain: 'elewacje-nowak.example.pl', country: 'PL', city: 'Kraków', recipe: 'pl_facade', run: 1, outcome: 'new', contact: ['Katarzyna', 'Lewandowska', 'Specjalistka ds. zakupów'], blurb: 'Elewacje wentylowane, okładziny i ocieplenia dla deweloperów w Małopolsce.' },
  { name: 'PPHU Ociepl-Dom', domain: 'ociepl-dom.example.pl', country: 'PL', city: 'Rzeszów', recipe: 'pl_facade', run: 1, outcome: 'reject', blurb: 'Docieplenia domów jednorodzinnych styropianem, tynki, malowanie. Obsługa klientów indywidualnych.' },
  { name: 'Pożar-Stop Systemy Sp. z o.o.', domain: 'pozarstop.example.pl', country: 'PL', city: 'Poznań', recipe: 'pl_facade', run: 1, outcome: 'needs_review', blurb: 'Zabezpieczenia przeciwpożarowe przejść instalacyjnych, uszczelnienia ogniochronne, przegrody.' },
  { name: 'Wrocławskie Konstrukcje Stalowe', domain: 'wks-stal.example.pl', country: 'PL', city: 'Wrocław', recipe: 'pl_facade', run: 1, outcome: 'reject', blurb: 'Produkcja i montaż konstrukcji stalowych hal, antykorozja i malowanie przemysłowe.' },
  { name: 'Baltic Facade Systems', domain: 'baltic-facade.example.pl', country: 'PL', city: 'Szczecin', recipe: 'pl_facade', run: 1, outcome: 'new', blurb: 'Systemy fasadowe i obudowy z płyt warstwowych dla terminali portowych i magazynów.' },
  { name: 'EnergoMontaż Bełchatów', domain: 'energomontaz.example.pl', country: 'PL', city: 'Bełchatów', recipe: 'pl_facade', run: 1, outcome: 'new', blurb: 'Montaże i izolacje w energetyce: kotłownie, rurociągi, obudowy maszynowni.' },
  { name: 'Olsztyńska Grupa Budowlana', domain: 'ogb-olsztyn.example.pl', country: 'PL', city: 'Olsztyn', recipe: 'pl_facade', run: 1, outcome: 'needs_review', blurb: 'Generalne wykonawstwo budynków mieszkalnych i biurowych na Warmii.' },

  // ---------------- run 2: de_fire, 20 days ago ----------------
  { name: 'Brandschutz Krüger GmbH', domain: 'brandschutz-krueger.example.de', country: 'DE', city: 'Hamburg', recipe: 'de_fire', run: 2, outcome: 'lead', lead: 'C3', contact: ['Stefan', 'Krüger', 'Geschäftsführer'], blurb: 'Fachbetrieb für baulichen Brandschutz: Brandabschottungen, Kabel- und Rohrdurchführungen in Hamburg.' },
  { name: 'Isoliertechnik Rhein-Ruhr GmbH', domain: 'isotech-rheinruhr.example.de', country: 'DE', city: 'Duisburg', recipe: 'de_fire', run: 2, outcome: 'lead', lead: 'P3', product: 'aerogel', contact: ['Markus', 'Becker', 'Technischer Leiter'], blurb: 'Industrieisolierung für Kraftwerke und Chemieanlagen im Ruhrgebiet, Kälte- und Wärmedämmung.' },
  { name: 'Rechenzentrum Ausbau Frankfurt GmbH', domain: 'rz-ausbau-ffm.example.de', country: 'DE', city: 'Frankfurt am Main', recipe: 'de_fire', run: 2, outcome: 'lead', lead: 'Q3', contact: ['Julia', 'Hoffmann', 'Einkaufsleiterin'], blurb: 'Ausbau von Rechenzentren: Brandschutz, Doppelböden, Abschottungen von Kabeltrassen in Frankfurt.' },
  { name: 'Hansa Dämmtechnik GmbH', domain: 'hansa-daemmtechnik.example.de', country: 'DE', city: 'Lübeck', recipe: 'de_fire', run: 2, outcome: 'lead', lead: 'X2', product: 'aerogel', contact: ['Thomas', 'Richter', 'Bauleiter'], blurb: 'Technische Dämmung für Industrie und Gebäudetechnik in Schleswig-Holstein.' },
  { name: 'Hessen Rohrleitungsbau GmbH', domain: 'hessen-rohr.example.de', country: 'DE', city: 'Kassel', recipe: 'de_fire', run: 2, outcome: 'lead', lead: 'R3', contact: ['Sabine', 'Wolf', 'Einkauf'], blurb: 'Rohrleitungsbau, Brandschutzmanschetten und Abschottungen für Industrie und Krankenhäuser.' },
  { name: 'Feuerschutz Bayern Süd GmbH', domain: 'feuerschutz-bayern.example.de', country: 'DE', city: 'München', recipe: 'de_fire', run: 2, outcome: 'new', contact: ['Anna', 'Schulz', 'Projektleiterin'], blurb: 'Vorbeugender Brandschutz, Fugenabdichtungen und Brandschutzklappen in Südbayern.' },
  { name: 'Kältetechnik Nord Isolierung', domain: 'kaelte-nord.example.de', country: 'DE', city: 'Bremen', recipe: 'de_fire', run: 2, outcome: 'new', product: 'aerogel', blurb: 'Kälteisolierung für Kühlhäuser, Lebensmittelindustrie und LNG-Anwendungen.' },
  { name: 'Sachsen Brandabschottung GmbH', domain: 'sachsen-abschottung.example.de', country: 'DE', city: 'Dresden', recipe: 'de_fire', run: 2, outcome: 'new', blurb: 'Brandabschottungen und Brandschutzbeschichtungen für Halbleiterwerke und Rechenzentren.' },
  { name: 'Industrieisolierung Leuna GmbH', domain: 'iso-leuna.example.de', country: 'DE', city: 'Leuna', recipe: 'de_fire', run: 2, outcome: 'needs_review', product: 'aerogel', blurb: 'Wärme-, Kälte- und Schallschutz für den Chemiestandort Leuna.' },
  { name: 'TGA Planungsbüro Weber', domain: 'tga-weber.example.de', country: 'DE', city: 'Stuttgart', recipe: 'de_fire', run: 2, outcome: 'reject', blurb: 'Planungsbüro für technische Gebäudeausrüstung. Beratung und Fachplanung, keine Ausführung.' },
  { name: 'Schwarzwald Holzbau', domain: 'schwarzwald-holzbau.example.de', country: 'DE', city: 'Freiburg', recipe: 'de_fire', run: 2, outcome: 'reject', blurb: 'Holzhäuser, Dachstühle und Carports für Privatkunden im Schwarzwald.' },
  { name: 'Roma Facility Services S.r.l.', domain: 'roma-facility.example.it', country: 'IT', city: 'Roma', recipe: 'de_fire', run: 2, outcome: 'mismatch', blurb: 'Facility management e manutenzione antincendio per uffici a Roma.' },

  // ---------------- run 3: it_directory, 16 days ago ----------------
  { name: 'Coibentazioni Industriali Milano S.p.A.', domain: 'coibentazioni-milano.example.it', country: 'IT', city: 'Milano', recipe: 'it_directory', run: 3, outcome: 'lead', lead: 'C5', contact: ['Giulia', 'Romano', 'Responsabile acquisti'], blurb: 'Coibentazioni industriali, isolamento tubazioni e serbatoi per impianti chimici e farmaceutici.' },
  { name: 'Antincendio Veneto S.r.l.', domain: 'antincendio-veneto.example.it', country: 'IT', city: 'Padova', recipe: 'it_directory', run: 3, outcome: 'lead', lead: 'I2', product: 'sealant', contact: ['Luca', 'Esposito', 'Project manager'], blurb: 'Protezione passiva dal fuoco: sigillature, collari e barriere per attraversamenti impiantistici.' },
  { name: 'Termoimpianti Sud S.r.l.', domain: 'termoimpianti-sud.example.it', country: 'IT', city: 'Napoli', recipe: 'it_directory', run: 3, outcome: 'lead', lead: 'X4', contact: ['Alessandro', 'Greco', 'Amministratore'], blurb: 'Impianti termici e coibentazioni per ospedali e strutture pubbliche in Campania.' },
  { name: 'Emilia HVAC Engineering', domain: 'emilia-hvac.example.it', country: 'IT', city: 'Bologna', recipe: 'it_directory', run: 3, outcome: 'lead', lead: 'R5', contact: ['Francesca', 'Ricci', 'Ufficio acquisti'], blurb: 'Progettazione e installazione HVAC con isolamento di reti di teleriscaldamento in Emilia.' },
  { name: 'Petrolchimica Servizi Priolo', domain: 'psp-priolo.example.it', country: 'IT', city: 'Siracusa', recipe: 'it_directory', run: 3, outcome: 'new', contact: ['Marco', 'Bianchi', 'Direttore tecnico'], blurb: 'Manutenzione, coibentazione e ponteggi per il polo petrolchimico di Priolo.' },
  { name: 'Data Center Lombardia Costruzioni', domain: 'dcl-costruzioni.example.it', country: 'IT', city: 'Milano', recipe: 'it_directory', run: 3, outcome: 'new', product: 'sealant', blurb: 'Costruzione di data center chiavi in mano: compartimentazioni REI e sigillature antincendio.' },
  { name: 'Genova Porto Isolamenti', domain: 'gpi-isolamenti.example.it', country: 'IT', city: 'Genova', recipe: 'it_directory', run: 3, outcome: 'new', blurb: 'Isolamento termico di linee criogeniche e serbatoi nel porto di Genova.' },
  { name: 'Facciate Ventilate Torino', domain: 'facciate-torino.example.it', country: 'IT', city: 'Torino', recipe: 'it_directory', run: 3, outcome: 'needs_review', blurb: 'Facciate ventilate e cappotti termici per edifici residenziali e direzionali.' },
  { name: 'Toscana Protezione Passiva', domain: 'toscana-pp.example.it', country: 'IT', city: 'Firenze', recipe: 'it_directory', run: 3, outcome: 'needs_review', product: 'sealant', blurb: 'Protezione passiva, intonaci ignifughi e sigillature per edifici storici.' },
  { name: 'Puglia Energia Manutenzioni', domain: 'puglia-energia.example.it', country: 'IT', city: 'Taranto', recipe: 'it_directory', run: 3, outcome: 'ignored', blurb: 'Manutenzioni meccaniche ed elettriche per acciaierie e centrali.' },

  // ---------------- run 4: uk_aerogel, 9 days ago ----------------
  { name: 'Thermaguard Industrial Services Ltd', domain: 'thermaguard-industrial.example.co.uk', country: 'GB', city: 'Aberdeen', recipe: 'uk_aerogel', run: 4, outcome: 'lead', lead: 'C1', contact: ['James', 'Whitaker', 'Operations Director'], blurb: 'Industrial insulation, CUI remediation and cryogenic pipe insulation for North Sea and onshore process plants.' },
  { name: 'Humber Process Insulation Ltd', domain: 'humber-process.example.co.uk', country: 'GB', city: 'Hull', recipe: 'uk_aerogel', run: 4, outcome: 'lead', lead: 'P1', contact: ['Sarah', 'Holloway', 'Procurement Manager'], blurb: 'Process insulation for refineries and biofuel plants on the Humber; hot and cold service, CUI programmes.' },
  { name: 'Anglia Pipework Insulation', domain: 'anglia-pipework.example.co.uk', country: 'GB', city: 'Norwich', recipe: 'uk_aerogel', run: 4, outcome: 'lead', lead: 'R1', contact: ['Hannah', 'Price', 'Buyer'], blurb: 'Pipework insulation for food processing, breweries and cold stores in East Anglia.' },
  { name: 'Yorkshire Heat Networks Ltd', domain: 'yorkshire-heatnet.example.co.uk', country: 'GB', city: 'Sheffield', recipe: 'uk_aerogel', run: 4, outcome: 'lead', lead: 'R4', contact: ['Priya', 'Natarajan', 'Estimating Manager'], blurb: 'District heating network installer: pre-insulated pipe, plant rooms and retrofit of legacy steam mains.' },
  { name: 'Fenland Cold Store Contractors', domain: 'fenland-coldstore.example.co.uk', country: 'GB', city: 'Peterborough', recipe: 'uk_aerogel', run: 4, outcome: 'lead', lead: 'R6', contact: ['Claire', 'Donnelly', 'Purchasing Lead'], blurb: 'Cold store construction and refrigeration pipework insulation for food distribution centres.' },
  { name: 'Global Thermal Solutions', domain: 'globalthermal.example.com', country: null, city: null, recipe: 'uk_aerogel', run: 4, outcome: 'unverified', blurb: 'Thermal insulation solutions for industrial pipework, tanks and vessels. Aerogel and mineral fibre systems.' },
  { name: 'ProFire Seal Contractors', domain: 'profireseal.example.com', country: null, city: null, recipe: 'uk_aerogel', run: 4, outcome: 'unverified', product: 'sealant', blurb: 'Fire stopping and penetration sealing contractors for commercial and industrial projects.' },
  { name: 'Cryo Line Services', domain: 'cryoline.example.com', country: null, city: null, recipe: 'uk_aerogel', run: 4, outcome: 'unverified', blurb: 'Cryogenic line insulation, cold box repair and vacuum jacketed piping services.' },
  { name: 'Insul8 Group', domain: 'insul8.example.com', country: null, city: null, recipe: 'uk_aerogel', run: 4, outcome: 'unverified', blurb: 'Insulation group delivering HVAC, process and marine insulation packages.' },
  { name: 'Isolterm Adriatica S.r.l.', domain: 'isolterm-adriatica.example.it', country: 'IT', city: 'Ravenna', recipe: 'uk_aerogel', run: 4, outcome: 'mismatch', blurb: 'Coibentazioni per impianti offshore e onshore nel distretto di Ravenna.' },

  // ---------------- run 5: uk_tenders, 19 days ago ----------------
  { name: 'Midlands Firestop Solutions', domain: 'midlands-firestop.example.co.uk', country: 'GB', city: 'Birmingham', recipe: 'uk_tenders', run: 5, outcome: 'lead', lead: 'C6', contact: ['Daniel', 'Hughes', 'Operations Manager'], blurb: 'Third-party certified fire stopping contractor. Awarded lot 2 of the NHS estates passive fire framework.' },
  { name: 'Capital Passive Fire Protection', domain: 'capital-pfp.example.co.uk', country: 'GB', city: 'London', recipe: 'uk_tenders', run: 5, outcome: 'lead', lead: 'P4', contact: ['Emma', 'Lawson', 'Office Manager'], blurb: 'Passive fire protection for London commercial towers and hospitals. Bidding on remedial fire stopping tenders.' },
  { name: 'Pennine Fire Stopping Ltd', domain: 'pennine-firestopping.example.co.uk', country: 'GB', city: 'Leeds', recipe: 'uk_tenders', run: 5, outcome: 'new', blurb: 'Fire stopping and compartmentation surveys and remedials for housing associations in Yorkshire.' },
  { name: 'Thames Data Centre Fit-Out Ltd', domain: 'thames-dcfitout.example.co.uk', country: 'GB', city: 'Slough', recipe: 'uk_tenders', run: 5, outcome: 'new', blurb: 'Data centre fit-out contractor: containment, cable penetrations and fire-rated sealing.' },
  { name: 'Wessex Passive Fire Ltd', domain: 'wessex-passivefire.example.co.uk', country: 'GB', city: 'Salisbury', recipe: 'uk_tenders', run: 5, outcome: 'ignored', blurb: 'Small passive fire team, mostly subcontracted to main contractors in Wiltshire.' },
  { name: 'Leeds City Council — Building Services', domain: 'leeds-buildingservices.example.co.uk', country: 'GB', city: 'Leeds', recipe: 'uk_tenders', run: 5, outcome: 'ignored', blurb: 'Contracting authority publishing a fire-stopping remediation tender for council housing blocks.' },

  // ---------------- run 6: pl_facade, FAILED 4 days ago (partial) ----------------
  { name: 'Mazowieckie Centrum Dociepleń', domain: 'mcd-docieplenia.example.pl', country: 'PL', city: 'Radom', recipe: 'pl_facade', run: 6, outcome: 'reject', blurb: 'Docieplenia domów i bloków styropianem metodą lekką-mokrą.' },
  { name: 'Fasada-Pro Bydgoszcz', domain: 'fasadapro.example.pl', country: 'PL', city: 'Bydgoszcz', recipe: 'pl_facade', run: 6, outcome: 'duplicate', blurb: 'Fasady wentylowane — ta sama firma co Baltic Facade Systems (oddział).' },
  { name: 'Tarnów Chem-Izol', domain: 'chemizol.example.pl', country: 'PL', city: 'Tarnów', recipe: 'pl_facade', run: 6, outcome: 'new', blurb: 'Izolacje termiczne zakładów chemicznych i obudowy hal produkcyjnych w Tarnowie.' },
  { name: 'Zielona Góra Termomodernizacje', domain: 'zg-termo.example.pl', country: 'PL', city: 'Zielona Góra', recipe: 'pl_facade', run: 6, outcome: 'archived', blurb: 'Termomodernizacje szkół i budynków gminnych (zakończona działalność).' },

  // ---------------- run 7: de_fire, FAILED 2 days ago (partial) ----------------
  { name: 'Emsland Biogas Service', domain: 'emsland-biogas.example.de', country: 'DE', city: 'Lingen', recipe: 'de_fire', run: 7, outcome: 'ignored', blurb: 'Service und Wartung von Biogasanlagen im Emsland.' },
  { name: 'Westfalen Fassadenbau', domain: 'westfalen-fassaden.example.de', country: 'DE', city: 'Münster', recipe: 'de_fire', run: 7, outcome: 'reject', blurb: 'Vorgehängte hinterlüftete Fassaden und WDVS für Wohnungsbau.' },
  { name: 'Berliner Brandschutzsysteme', domain: 'bbs-berlin.example.de', country: 'DE', city: 'Berlin', recipe: 'de_fire', run: 7, outcome: 'duplicate', blurb: 'Brandschutzsysteme und Abschottungen — Dublette von Brandschutz Krüger (Niederlassung Berlin).' },

  // ---------------- run 8: uk_aerogel, RUNNING now ----------------
  { name: 'Tyneside Offshore Insulation', domain: 'tyneside-offshore.example.co.uk', country: 'GB', city: 'Newcastle upon Tyne', recipe: 'uk_aerogel', run: 8, outcome: 'new', blurb: 'Offshore module insulation, cryogenic spools and fabrication yard insulation packages on the Tyne.' },
  { name: 'Cotswold Building Envelope Ltd', domain: 'cotswold-envelope.example.co.uk', country: 'GB', city: 'Cheltenham', recipe: 'uk_aerogel', run: 8, outcome: 'needs_review', blurb: 'Building envelope and cladding contractor; occasional plant room insulation packages.' },
];

const PRODUCT_LABEL: Record<ProductKey, string> = {
  aerogel: 'Aerogel insulation blankets',
  wool: 'Mineral wool panels',
  sealant: 'Fire-rated sealants',
};

interface RecipeSpec {
  key: RecipeKey;
  connector: 'web' | 'directory' | 'tender';
  name: string;
  country: Country;
  language: string;
  products: ProductKey[];
  queries: string[];
  seedUrls: string[];
}

const RECIPES: RecipeSpec[] = [
  {
    key: 'uk_aerogel',
    connector: 'web',
    name: 'UK industrial insulation contractors — aerogel',
    country: 'GB',
    language: 'en',
    products: ['aerogel', 'sealant'],
    queries: [
      'aerogel pipe insulation contractor UK',
      'CUI remediation insulation contractor',
      'cryogenic pipe insulation LNG terminal UK',
      'district heating pipe insulation retrofit contractor',
    ],
    seedUrls: [],
  },
  {
    key: 'uk_tenders',
    connector: 'tender',
    name: 'UK public tenders — fire stopping & compartmentation',
    country: 'GB',
    language: 'en',
    products: ['sealant'],
    queries: ['fire stopping', 'compartmentation remedial works', 'passive fire protection framework'],
    seedUrls: ['https://tenders.example.co.uk/search?cpv=45343000'],
  },
  {
    key: 'pl_facade',
    connector: 'web',
    name: 'PL wykonawcy fasad i izolacji — wełna mineralna',
    country: 'PL',
    language: 'pl',
    products: ['wool'],
    queries: [
      'fasady wentylowane wykonawca wełna mineralna',
      'izolacje przemysłowe wykonawca',
      'obudowy hal płyty warstwowe wełna',
    ],
    seedUrls: [],
  },
  {
    key: 'de_fire',
    connector: 'web',
    name: 'DE Brandschutz-Fachbetriebe — Abschottungen',
    country: 'DE',
    language: 'de',
    products: ['sealant', 'aerogel'],
    queries: ['Brandschutz Fachbetrieb Abschottung', 'Brandabschottung Rechenzentrum', 'Industrieisolierung Kälte'],
    seedUrls: [],
  },
  {
    key: 'it_directory',
    connector: 'directory',
    name: 'IT directory — coibentazioni & antincendio',
    country: 'IT',
    language: 'it',
    products: ['aerogel', 'sealant'],
    queries: [],
    seedUrls: [
      'https://directory.example.it/categoria/coibentazioni-industriali',
      'https://directory.example.it/categoria/protezione-passiva-antincendio',
    ],
  },
];

interface RunSpec {
  recipe: RecipeKey;
  status: 'succeeded' | 'failed' | 'running' | 'cancelled' | 'pending';
  startedDaysAgo: number;
  startedHoursAgo?: number;
  durationMin: number;
  error?: { message: string; code?: string; payload?: Record<string, unknown> };
  progress?: number;
}

// Index = CompanySpec.run
const RUN_SPECS: RunSpec[] = [
  { recipe: 'uk_aerogel', status: 'succeeded', startedDaysAgo: 27, startedHoursAgo: 3, durationMin: 14 },
  { recipe: 'pl_facade', status: 'succeeded', startedDaysAgo: 24, startedHoursAgo: 5, durationMin: 11 },
  { recipe: 'de_fire', status: 'succeeded', startedDaysAgo: 20, startedHoursAgo: 2, durationMin: 9 },
  { recipe: 'it_directory', status: 'succeeded', startedDaysAgo: 16, startedHoursAgo: 6, durationMin: 22 },
  { recipe: 'uk_aerogel', status: 'succeeded', startedDaysAgo: 9, startedHoursAgo: 4, durationMin: 12 },
  { recipe: 'uk_tenders', status: 'succeeded', startedDaysAgo: 19, startedHoursAgo: 1, durationMin: 6 },
  {
    recipe: 'pl_facade',
    status: 'failed',
    startedDaysAgo: 4,
    startedHoursAgo: 2,
    durationMin: 3,
    error: {
      message: 'SerpAPI returned HTTP 429 (rate limit exceeded) on query 2 of 3 — run aborted after partial results',
      code: 'search_rate_limited',
      payload: { provider: 'serpapi', status: 429, query: 'izolacje przemysłowe wykonawca', retryAfterSeconds: 3600 },
    },
  },
  {
    recipe: 'de_fire',
    status: 'failed',
    startedDaysAgo: 2,
    startedHoursAgo: 7,
    durationMin: 5,
    error: {
      message: 'Timeout fetching results page 3 after 30000 ms',
      code: 'fetch_timeout',
      payload: { provider: 'serpapi', page: 3, timeoutMs: 30000 },
    },
  },
  { recipe: 'uk_aerogel', status: 'running', startedDaysAgo: 0, startedHoursAgo: 0, durationMin: 0, progress: 40 },
  { recipe: 'it_directory', status: 'cancelled', startedDaysAgo: 12, startedHoursAgo: 1, durationMin: 2 },
];

// Pipeline plan for each lead.
interface LeadPlan {
  state: s.PipelineState;
  /** Days ago the lead became relevant (review approved). */
  relevantAgo: number;
  contactedAgo?: number;
  repliedAgo?: number;
  identifiedAgo?: number;
  qualifiedAgo?: number;
  handedAgo?: number;
  syncedAgo?: number;
  closedAgo?: number;
  closeReason?: s.CloseReason;
  closeNote?: string;
  assignee: 'admin' | 'member' | null;
  tags: string[];
  notes?: string;
}

const LEAD_PLANS: Record<LeadKey, LeadPlan> = {
  R1: { state: 'relevant', relevantAgo: 7, assignee: 'member', tags: ['cold-store'] },
  R2: { state: 'relevant', relevantAgo: 6, assignee: 'member', tags: ['hvac'] },
  R3: { state: 'relevant', relevantAgo: 5, assignee: 'admin', tags: ['hospital'] },
  R4: { state: 'relevant', relevantAgo: 3, assignee: 'member', tags: ['district-heating', 'priority'] },
  R5: { state: 'relevant', relevantAgo: 4, assignee: null, tags: ['district-heating'] },
  R6: { state: 'relevant', relevantAgo: 6, assignee: 'member', tags: ['cold-store'] },
  R7: { state: 'relevant', relevantAgo: 8, assignee: null, tags: [] },
  C1: { state: 'contacted', relevantAgo: 4, contactedAgo: 2, assignee: 'member', tags: ['cui'] },
  C2: { state: 'contacted', relevantAgo: 13, contactedAgo: 9, assignee: 'member', tags: ['port'] },
  C3: { state: 'contacted', relevantAgo: 12, contactedAgo: 8, assignee: 'admin', tags: [] },
  C4: { state: 'contacted', relevantAgo: 20, contactedAgo: 12, assignee: 'member', tags: ['marine'] },
  C5: { state: 'contacted', relevantAgo: 10, contactedAgo: 5, assignee: null, tags: ['pharma'] },
  C6: { state: 'contacted', relevantAgo: 17, contactedAgo: 15, assignee: 'admin', tags: ['nhs', 'framework'] },
  P1: { state: 'replied', relevantAgo: 7, contactedAgo: 6, repliedAgo: 1, assignee: 'member', tags: ['refinery', 'priority'] },
  P2: { state: 'replied', relevantAgo: 16, contactedAgo: 11, repliedAgo: 2, assignee: 'member', tags: ['office'] },
  P3: { state: 'replied', relevantAgo: 15, contactedAgo: 10, repliedAgo: 3, assignee: 'admin', tags: ['power'] },
  P4: { state: 'replied', relevantAgo: 16, contactedAgo: 13, repliedAgo: 4, assignee: 'admin', tags: ['referral'] },
  I1: { state: 'contact_identified', relevantAgo: 24, contactedAgo: 21, repliedAgo: 17, identifiedAgo: 16, assignee: 'member', tags: ['chemicals'] },
  I2: { state: 'contact_identified', relevantAgo: 14, contactedAgo: 12, repliedAgo: 8, identifiedAgo: 7, assignee: 'admin', tags: [] },
  Q1: { state: 'qualified', relevantAgo: 25, contactedAgo: 22, repliedAgo: 19, identifiedAgo: 19, qualifiedAgo: 9, assignee: 'member', tags: ['distillery', 'call-booked'], notes: 'Teams call booked with Fiona — wants pricing for 2 km of 200 mm steam main.' },
  Q2: { state: 'qualified', relevantAgo: 22, contactedAgo: 20, repliedAgo: 15, identifiedAgo: 15, qualifiedAgo: 6, assignee: 'member', tags: ['refinery'], notes: 'Próbki 3 typów płyt wysłane kurierem; czekają na wyniki testów.' },
  Q3: { state: 'qualified', relevantAgo: 18, contactedAgo: 17, repliedAgo: 12, identifiedAgo: 12, qualifiedAgo: 4, assignee: 'admin', tags: ['data-centre', 'priority'] },
  H1: { state: 'handed_over', relevantAgo: 26, contactedAgo: 24, repliedAgo: 21, identifiedAgo: 21, qualifiedAgo: 14, handedAgo: 10, assignee: 'admin', tags: ['lng', 'key-account'], notes: 'Handed to UK field sales (Ben). Site survey planned.' },
  H2: { state: 'handed_over', relevantAgo: 23, contactedAgo: 21, repliedAgo: 18, identifiedAgo: 18, qualifiedAgo: 11, handedAgo: 5, assignee: 'member', tags: ['data-centre'] },
  S1: { state: 'synced_to_crm', relevantAgo: 26, contactedAgo: 25, repliedAgo: 22, identifiedAgo: 22, qualifiedAgo: 15, handedAgo: 12, syncedAgo: 11, assignee: 'admin', tags: ['offshore', 'key-account'] },
  X1: { state: 'closed', relevantAgo: 26, contactedAgo: 25, repliedAgo: 23, identifiedAgo: 23, qualifiedAgo: 18, handedAgo: 14, closedAgo: 3, closeReason: 'won', closeNote: 'First order: 120 rolls AG10 for the Avonmouth retrofit.', assignee: 'admin', tags: ['won'] },
  X2: { state: 'closed', relevantAgo: 18, contactedAgo: 16, repliedAgo: 14, closedAgo: 14, closeReason: 'lost', closeNote: 'Exclusive framework with another supplier until 2028.', assignee: 'admin', tags: [] },
  X3: { state: 'closed', relevantAgo: 22, contactedAgo: 19, closedAgo: 18, closeReason: 'no_response', closeNote: 'Hard bounce — address no longer exists.', assignee: null, tags: ['bounced'] },
  X4: { state: 'closed', relevantAgo: 14, contactedAgo: 13, repliedAgo: 11, closedAgo: 11, closeReason: 'wrong_fit', closeNote: 'Asked to be removed from mailing.', assignee: null, tags: ['unsubscribed'] },
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`seeding lead_demo — now = ${NOW.toISOString()}`);
  await truncateAll();

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  // ======================= users =======================
  const ADMIN_ID = '0d3e0000-0000-4000-8000-00000000a001';
  const MEMBER_ID = '0d3e0000-0000-4000-8000-00000000a002';
  const LENA_ID = '0d3e0000-0000-4000-8000-00000000a003';
  const PENDING_ID = '0d3e0000-0000-4000-8000-00000000a004';
  const SUSPENDED_ID = '0d3e0000-0000-4000-8000-00000000a005';
  const PILOT_ID = '0d3e0000-0000-4000-8000-00000000a006';
  const REJECTED_ID = '0d3e0000-0000-4000-8000-00000000a007';

  await db.insert(s.users).values([
    {
      id: ADMIN_ID,
      name: 'Jordan Avery',
      email: 'demo-admin@example.com',
      emailVerified: ago(40),
      role: 'super_admin',
      accountStatus: 'active',
      accountStatusUpdatedAt: ago(40),
      passwordHash,
      createdAt: ago(40),
      lastSignedInAt: ago(0, 2),
    },
    {
      id: MEMBER_ID,
      name: 'Marta Zielonka',
      email: 'demo-member@example.com',
      emailVerified: ago(35),
      role: 'member',
      accountStatus: 'active',
      accountStatusUpdatedAt: ago(35),
      accountStatusUpdatedBy: ADMIN_ID,
      passwordHash,
      createdAt: ago(35),
      lastSignedInAt: ago(0, 5),
    },
    {
      id: LENA_ID,
      name: 'Lena Berg',
      email: 'lena.berg@example.com',
      role: 'member',
      accountStatus: 'active',
      accountStatusUpdatedAt: ago(11),
      accountStatusUpdatedBy: ADMIN_ID,
      createdAt: ago(12),
      lastSignedInAt: ago(1, 3),
    },
    {
      id: PENDING_ID,
      name: 'Tomasz Wrona',
      email: 'tomasz.wrona@example.com',
      role: 'member',
      accountStatus: 'pending',
      createdAt: ago(1, 6),
      lastSignedInAt: ago(1, 6),
    },
    {
      id: SUSPENDED_ID,
      name: 'Olaf Brandt',
      email: 'olaf.brandt@example.de',
      role: 'member',
      accountStatus: 'suspended',
      accountStatusReason: 'Left the partner agency — access paused pending handover.',
      accountStatusUpdatedAt: ago(6),
      accountStatusUpdatedBy: ADMIN_ID,
      createdAt: ago(33),
      lastSignedInAt: ago(7),
    },
    {
      id: PILOT_ID,
      name: 'Rachel Moss',
      email: 'rachel.moss@example.co.uk',
      role: 'member',
      accountStatus: 'active',
      createdAt: ago(60),
      lastSignedInAt: ago(45),
    },
    {
      id: REJECTED_ID,
      name: null,
      email: 'unknown.signup@example.net',
      role: 'member',
      accountStatus: 'rejected',
      accountStatusReason: 'Not a customer — self sign-up from an unknown domain.',
      accountStatusUpdatedAt: ago(9),
      accountStatusUpdatedBy: ADMIN_ID,
      createdAt: ago(9, 2),
      lastSignedInAt: ago(9, 2),
    },
  ]);

  // ======================= workspaces =======================
  const followUpStepConfigs = [
    { daysAfterPrev: 4, customInstructions: 'Short nudge. Reference the CUI / cold-line angle, ask who owns insulation specs.' },
    { daysAfterPrev: 6, customInstructions: 'Offer a 1-page case study (Teesside retrofit) and a 15-minute call. No attachments.' },
    { daysAfterPrev: 8, customInstructions: 'Explicit final email: polite close-out, leave the door open, no pressure.' },
  ];

  const [wsA] = await db
    .insert(s.workspaces)
    .values({
      name: 'Northwind Insulation (demo)',
      slug: 'northwind-insulation-demo',
      status: 'active',
      ownerUserId: ADMIN_ID,
      onboardingStatus: 'completed',
      setupMode: 'advanced',
      plan: 'pro',
      subscriptionStatus: 'active',
      tokenBalance: 8200n,
      autoTopupEnabled: true,
      autoTopupPackId: 'pack_m',
      autoTopupLastAt: null,
      healthCheckEnabled: true,
      healthCheckIntervalDays: 7,
      healthCheckLastAt: ago(1, 4),
      autoDraftReplies: true,
      autoSendReplies: false,
      followUpEnabled: true,
      followUpIntervalDays: 6,
      followUpMaxSteps: 3,
      followUpRequireApproval: true,
      followUpStepConfigs,
      trashRetentionDays: 30,
      imapAutoSyncEnabled: true,
      createdAt: ago(38),
      updatedAt: ago(1),
    })
    .returning();
  const [wsB] = await db
    .insert(s.workspaces)
    .values({
      name: 'Baltic Steel Trading (demo)',
      slug: 'baltic-steel-trading-demo',
      status: 'active',
      ownerUserId: LENA_ID,
      onboardingStatus: 'in_progress',
      setupMode: 'simple',
      plan: 'trial',
      subscriptionStatus: 'trial',
      trialEndsAt: ahead(3),
      tokenBalance: 312n,
      createdAt: ago(11),
      updatedAt: ago(1),
    })
    .returning();
  const [wsC] = await db
    .insert(s.workspaces)
    .values({
      name: 'Pilot Workspace 2025 (archived demo)',
      slug: 'pilot-workspace-2025-demo',
      status: 'archived',
      archivedAt: ago(28),
      archivedBy: ADMIN_ID,
      archivedReason: 'Pilot finished; data kept for reference.',
      ownerUserId: PILOT_ID,
      onboardingStatus: 'completed',
      setupMode: 'simple',
      plan: 'starter',
      subscriptionStatus: 'canceled',
      tokenBalance: 0n,
      createdAt: ago(90),
      updatedAt: ago(28),
    })
    .returning();
  const A = must(wsA, 'workspace A').id;
  const B = must(wsB, 'workspace B').id;
  const C = must(wsC, 'workspace C').id;

  await db.insert(s.workspaceMembers).values([
    { workspaceId: A, userId: ADMIN_ID, role: 'owner', createdAt: ago(38) },
    { workspaceId: A, userId: MEMBER_ID, role: 'manager', createdAt: ago(35) },
    { workspaceId: A, userId: SUSPENDED_ID, role: 'viewer', createdAt: ago(33) },
    // NOTE: demo users are deliberately NOT members of B — the dashboard
    // redirects to /onboarding when memberships[0] (unordered) is not
    // completed, and B is mid-onboarding on purpose.
    { workspaceId: B, userId: LENA_ID, role: 'owner', createdAt: ago(11) },
    { workspaceId: C, userId: PILOT_ID, role: 'owner', createdAt: ago(90) },
    { workspaceId: C, userId: ADMIN_ID, role: 'admin', createdAt: ago(90) },
  ]);

  await db.update(s.users).set({ activeWorkspaceId: A }).where(inUsers([ADMIN_ID, MEMBER_ID]));
  await db.update(s.users).set({ activeWorkspaceId: B }).where(inUsers([LENA_ID]));

  await db.insert(s.workspaceSettings).values([
    { workspaceId: A, settings: { nativeLanguage: 'en', outreachLanguage: null }, updatedAt: ago(20) },
    { workspaceId: B, settings: { nativeLanguage: 'pl' }, updatedAt: ago(10) },
    { workspaceId: C, settings: {}, updatedAt: ago(90) },
  ]);

  await db.insert(s.workspaceProviderSettings).values([
    {
      workspaceId: A,
      aiProvider: 'openai',
      aiModel: 'gpt-5-mini',
      embeddingProvider: 'openai',
      researchProvider: 'gemini',
      researchModel: 'gemini-2.5-flash',
      searchProvider: 'serpapi',
      vectorStorageProvider: 'pgvector',
      qualificationProvider: 'gemini',
      qualificationModel: 'gemini-2.5-flash',
      updatedBy: ADMIN_ID,
      updatedAt: ago(18),
    },
  ]);

  await db.insert(s.preauthorizedEmails).values([
    { email: 'new.hire@example.com', workspaceId: A.toString(), role: 'member', createdBy: ADMIN_ID, createdAt: ago(2) },
    { email: 'piotr.sales@example.com', workspaceId: B.toString(), role: 'member', createdBy: ADMIN_ID, createdAt: ago(8), consumedAt: null },
  ]);

  // ======================= products =======================
  const productRows = await db
    .insert(s.productProfiles)
    .values([
      {
        workspaceId: A,
        name: 'Aerogel insulation blankets',
        shortDescription: 'Thin, flexible aerogel blankets (5–10 mm) for hot, cold and cryogenic pipework, CUI prevention and space-constrained retrofits.',
        fullDescription:
          'NW-AG10 / NW-AG05 silica aerogel blankets reinforced with glass fibre. Thermal conductivity 0.021 W/m·K at 0 °C, service range −200 °C to +650 °C, hydrophobic throughout (reduces corrosion under insulation). Typically 2–5× thinner than mineral wool for the same heat loss, so it fits congested pipe racks and lets crews re-insulate without moving adjacent lines. Supplied in 1.5 m wide rolls; cut on site with standard knives.',
        targetCustomerTypes: ['Industrial insulation contractors', 'EPC contractors', 'Plant maintenance contractors'],
        targetSectors: ['Oil & gas', 'LNG', 'Petrochemical', 'District heating', 'Food & beverage'],
        targetProjectTypes: ['CUI remediation', 'Cryogenic line insulation', 'Steam main retrofit', 'Cold store pipework'],
        includeKeywords: ['aerogel', 'pipe insulation', 'CUI', 'cryogenic', 'thermal insulation', 'LNG', 'lagging', 'steam'],
        excludeKeywords: ['loft insulation', 'cavity wall', 'residential', 'DIY', 'homeowner'],
        qualificationCriteria: 'Contractor or maintenance company that installs insulation on industrial pipework, vessels or cold lines. Evidence of industrial/process clients. Located in the target country of the recipe.',
        disqualificationCriteria: 'Residential insulation installers, retailers/e-commerce, pure design consultancies, public bodies (unless as a buyer we can reach via contractors).',
        relevanceThreshold: 60,
        outreachInstructions: 'Lead with the space-saving + CUI angle. One concrete number (λ 0.021). Ask who owns insulation specs; never attach files in the first email.',
        negativeOutreachInstructions: 'Do not claim certifications we have not listed. No price in the first email. No "revolutionary".',
        forbiddenPhrases: ['revolutionary', 'game-changer', 'best in class', 'synergy'],
        discoveryAngle: 'Ask who handles insulation specs for congested pipe racks / CUI programmes.',
        engagementAngle: 'Answer their question in 2–3 sentences, offer a datasheet or a 15-minute call.',
        pitchAngle: 'Thickness comparison vs mineral wool on their line sizes; install-time saving; CUI reduction.',
        language: 'en',
        active: true,
        enrichDraftsWithResearch: true,
        crmMapping: { hubspotProductId: 'demo-aerogel', dealPipeline: 'default' },
        createdBy: ADMIN_ID,
        updatedBy: MEMBER_ID,
        createdAt: ago(37),
        updatedAt: ago(6),
      },
      {
        workspaceId: A,
        name: 'Mineral wool panels',
        shortDescription: 'Płyty z wełny mineralnej o wysokiej gęstości do fasad wentylowanych, obudów hal i przegród ogniowych (A1, EI 120).',
        fullDescription:
          'Płyty NW-MW Facade 70/90/110 kg/m³, klasa reakcji na ogień A1, λD 0,034 W/m·K. Przeznaczone do fasad wentylowanych, obudów hal przemysłowych i przegród o odporności ogniowej do EI 120 w systemach płyt warstwowych. Dostawy paletowe z magazynu w Poznaniu w 48 h.',
        targetCustomerTypes: ['Wykonawcy fasad', 'Generalni wykonawcy', 'Wykonawcy izolacji przemysłowych'],
        targetSectors: ['Budownictwo komercyjne', 'Logistyka', 'Centra danych', 'Przemysł'],
        targetProjectTypes: ['Fasady wentylowane', 'Obudowy hal', 'Ściany ogniowe'],
        includeKeywords: ['wełna mineralna', 'fasada wentylowana', 'izolacja', 'płyty warstwowe', 'ściana ogniowa', 'A1'],
        excludeKeywords: ['styropian', 'domy jednorodzinne', 'klient indywidualny'],
        qualificationCriteria: 'Wykonawca fasad, obudów lub izolacji dla obiektów komercyjnych/przemysłowych w Polsce.',
        disqualificationCriteria: 'Docieplenia domów jednorodzinnych styropianem, producenci konstrukcji stalowych, biura projektowe.',
        relevanceThreshold: 55,
        outreachInstructions: 'Pisz po polsku, krótko i rzeczowo. Jedno pytanie o osobę odpowiedzialną za dobór izolacji.',
        negativeOutreachInstructions: 'Bez cen w pierwszej wiadomości. Bez porównań z konkretnymi konkurentami.',
        forbiddenPhrases: ['rewolucyjny', 'najlepszy na rynku'],
        discoveryAngle: 'Kto u Państwa odpowiada za dobór izolacji do fasad i obudów hal?',
        engagementAngle: 'Odpowiedz konkretnie, zaproponuj próbki lub kartę techniczną.',
        pitchAngle: 'A1 + EI 120 w jednym systemie, dostawa 48 h z Poznania.',
        language: 'pl',
        active: true,
        enrichDraftsWithResearch: false,
        createdBy: ADMIN_ID,
        updatedBy: ADMIN_ID,
        createdAt: ago(36),
        updatedAt: ago(15),
      },
      {
        workspaceId: A,
        name: 'Fire-rated sealants',
        shortDescription: 'Intumescent and acrylic fire-rated sealants for service penetrations and linear joints — up to EI 240, tested to EN 1366-3/-4.',
        fullDescription:
          'NW-FS Intumescent (graphite-based) and NW-FS Acrylic sealants for cable bundles, plastic and metal pipes and linear gaps. Tested to EN 1366-3 and EN 1366-4, EI 60–240 depending on configuration. Paintable, low-VOC, cartridges and 600 ml sausages. Installer training and labelled penetration registers available.',
        targetCustomerTypes: ['Fire stopping contractors', 'MEP contractors', 'Data centre fit-out contractors'],
        targetSectors: ['Healthcare', 'Data centres', 'Commercial towers', 'Public housing remediation'],
        targetProjectTypes: ['Fire stopping remediation', 'Penetration sealing', 'Compartmentation surveys'],
        includeKeywords: ['fire stopping', 'passive fire', 'penetration seal', 'intumescent', 'Brandschutz', 'Abschottung', 'antincendio'],
        excludeKeywords: ['fire extinguisher', 'alarm', 'sprinkler servicing'],
        qualificationCriteria: 'Installs passive fire protection (penetrations, joints, compartmentation). Third-party certification is a plus.',
        disqualificationCriteria: 'Active fire (alarms, extinguishers, sprinklers) only; pure facility management; consultancies.',
        relevanceThreshold: 60,
        outreachInstructions: 'Mention tested configurations (EN 1366-3) and installer training. Ask who selects sealing products on their projects.',
        negativeOutreachInstructions: 'Never imply a product is compliant for a configuration that is not in the test report.',
        forbiddenPhrases: ['fireproof', '100% safe', 'guaranteed compliance'],
        discoveryAngle: 'Who chooses penetration sealing products on your remediation jobs?',
        engagementAngle: 'Point to the matching tested configuration; offer the test report extract.',
        pitchAngle: 'One intumescent sealant covering cables + plastic pipes up to 110 mm, EI 120.',
        language: 'en',
        active: true,
        enrichDraftsWithResearch: false,
        createdBy: MEMBER_ID,
        updatedBy: MEMBER_ID,
        createdAt: ago(30),
        updatedAt: ago(3),
      },
      {
        workspaceId: A,
        name: 'Reflective foil wrap (discontinued)',
        shortDescription: 'Legacy reflective foil wrap — no longer promoted; kept for historical leads.',
        targetCustomerTypes: ['Builders merchants'],
        targetSectors: ['Construction'],
        includeKeywords: ['reflective foil'],
        relevanceThreshold: 70,
        language: 'en',
        active: false,
        createdBy: ADMIN_ID,
        createdAt: ago(37),
        updatedAt: ago(29),
      },
      {
        workspaceId: B,
        name: 'S355 structural steel sections',
        shortDescription: 'HEA/HEB/IPE sections in S355J2, cut-to-length, delivered across the Baltic region.',
        targetCustomerTypes: ['Steel fabricators', 'General contractors'],
        targetSectors: ['Construction', 'Industrial buildings'],
        includeKeywords: ['steel fabrication', 'HEB', 'IPE', 'S355'],
        excludeKeywords: ['scrap', 'stainless cutlery'],
        qualificationCriteria: 'Fabricators or contractors buying structural sections in volume.',
        relevanceThreshold: 55,
        language: 'en',
        active: true,
        createdBy: LENA_ID,
        createdAt: ago(10),
        updatedAt: ago(10),
      },
      {
        workspaceId: B,
        name: 'Hot-rolled steel plate',
        shortDescription: 'Plate 6–100 mm, S235/S355, plasma and oxy cutting service.',
        targetCustomerTypes: ['Machine builders', 'Shipyards'],
        targetSectors: ['Manufacturing', 'Shipbuilding'],
        includeKeywords: ['steel plate', 'plasma cutting', 'shipyard'],
        relevanceThreshold: 50,
        language: 'pl',
        active: true,
        createdBy: LENA_ID,
        createdAt: ago(9),
        updatedAt: ago(9),
      },
    ])
    .returning();
  const productId = (name: string): bigint => must(productRows.find((p) => p.name === name), `product ${name}`).id;
  const P: Record<ProductKey, bigint> = {
    aerogel: productId('Aerogel insulation blankets'),
    wool: productId('Mineral wool panels'),
    sealant: productId('Fire-rated sealants'),
  };
  const PROD_LEGACY = productId('Reflective foil wrap (discontinued)');
  const PROD_B1 = productId('S355 structural steel sections');
  const PROD_B2 = productId('Hot-rolled steel plate');

  // ======================= connectors / recipes / plans =======================
  const connectorRows = await db
    .insert(s.connectors)
    .values([
      {
        workspaceId: A,
        templateType: 'internet_search',
        name: 'Internet Search',
        config: { provider: 'serpapi', maxResultsPerQuery: 10, country: null, language: null, safeSearch: true },
        credentialsRef: null,
        active: true,
        createdAt: ago(37),
        updatedAt: ago(9),
      },
      {
        workspaceId: A,
        templateType: 'directory_harvester',
        name: 'Directory Harvester',
        config: { baseUrl: 'https://directory.example.it', maxPages: 5, requestDelayMs: 1500, userAgent: 'LeadDiscoveryBot/1.0 (+demo)' },
        active: true,
        createdAt: ago(20),
        updatedAt: ago(16),
      },
      {
        workspaceId: A,
        templateType: 'tender_api',
        name: 'Tender API',
        config: { baseUrl: 'https://tenders.example.co.uk/api', lookbackDays: 30, cpvCodes: ['45343000', '45320000'] },
        active: true,
        createdAt: ago(22),
        updatedAt: ago(19),
      },
      {
        workspaceId: A,
        templateType: 'csv_import',
        name: 'CSV Import',
        config: { delimiter: ',', hasHeader: true },
        active: true,
        createdAt: ago(14),
        updatedAt: ago(14),
      },
      {
        workspaceId: A,
        templateType: 'mock',
        name: 'Sandbox (mock connector)',
        config: { recordCount: 5 },
        active: false,
        createdAt: ago(38),
        updatedAt: ago(30),
      },
      {
        workspaceId: B,
        templateType: 'internet_search',
        name: 'Internet Search',
        config: { provider: 'serpapi', maxResultsPerQuery: 10 },
        active: true,
        createdAt: ago(9),
        updatedAt: ago(9),
      },
    ])
    .returning();
  const CONN_WEB = must(connectorRows[0], 'conn web').id;
  const CONN_DIR = must(connectorRows[1], 'conn dir').id;
  const CONN_TENDER = must(connectorRows[2], 'conn tender').id;
  const CONN_B = must(connectorRows[5], 'conn B').id;
  const connectorFor = (k: RecipeSpec['connector']): bigint =>
    k === 'web' ? CONN_WEB : k === 'directory' ? CONN_DIR : CONN_TENDER;
  const templateFor = (k: RecipeSpec['connector']): s.ConnectorTemplateType =>
    k === 'web' ? 'internet_search' : k === 'directory' ? 'directory_harvester' : 'tender_api';

  const recipeIds = new Map<RecipeKey, bigint>();
  for (const r of RECIPES) {
    const [row] = await db
      .insert(s.connectorRecipes)
      .values({
        workspaceId: A,
        connectorId: connectorFor(r.connector),
        name: r.name,
        templateType: templateFor(r.connector),
        seedUrls: r.seedUrls,
        searchQueries: r.queries,
        selectors: recipeSelectors(r),
        paginationRules: recipePagination(r),
        enrichmentRules: { fetchHomepage: true, extractContacts: r.connector !== 'tender' },
        normalizationMapping: r.connector === 'tender' ? { title: 'notice.title', buyer: 'notice.buyer.name' } : {},
        evidenceRules: { requireDomain: true, minSnippetLength: 40 },
        active: true,
        createdAt: ago(30),
        updatedAt: ago(10),
      })
      .returning();
    recipeIds.set(r.key, must(row, 'recipe').id);
  }
  const recipeId = (k: RecipeKey): bigint => must(recipeIds.get(k), `recipe ${k}`);
  const recipeSpec = (k: RecipeKey): RecipeSpec => must(RECIPES.find((r) => r.key === k), `recipe spec ${k}`);

  // Workspace B recipe (small)
  const [recipeB] = await db
    .insert(s.connectorRecipes)
    .values({
      workspaceId: B,
      connectorId: CONN_B,
      name: 'Baltic steel fabricators',
      templateType: 'internet_search',
      searchQueries: ['steel fabrication company Lithuania', 'konstrukcje stalowe wytwórnia Pomorze'],
      selectors: { country: 'PL' },
      createdAt: ago(9),
      updatedAt: ago(9),
    })
    .returning();

  const planRows = await db.insert(s.crawlPlans).values([
    {
      workspaceId: A,
      name: 'Daily UK sweep',
      enabled: true,
      intervalMinutes: 1440,
      quietStartHour: 22,
      quietEndHour: 6,
      timezone: 'Europe/London',
      recipeIds: [recipeId('uk_aerogel'), recipeId('uk_tenders')],
      productProfileIds: [P.aerogel, P.sealant],
      lastRunAt: ago(0, 0, 6),
      nextRunAt: ahead(0, 23, 54),
      lastRunSummary: null,
      createdAt: ago(25),
      updatedAt: ago(0, 0, 6),
    },
    {
      workspaceId: A,
      name: 'PL + DE weekly',
      enabled: true,
      intervalMinutes: 10080,
      quietStartHour: null,
      quietEndHour: null,
      timezone: 'Europe/Warsaw',
      recipeIds: [recipeId('pl_facade'), recipeId('de_fire')],
      productProfileIds: [P.wool, P.sealant, P.aerogel],
      lastRunAt: ago(2, 7),
      nextRunAt: ahead(4, 17),
      lastRunSummary: null,
      createdAt: ago(24),
      updatedAt: ago(2, 7),
    },
    {
      workspaceId: A,
      name: 'Italy directory (paused)',
      enabled: false,
      intervalMinutes: 4320,
      timezone: 'Europe/Rome',
      recipeIds: [recipeId('it_directory')],
      productProfileIds: [P.aerogel, P.sealant],
      lastRunAt: ago(12, 1),
      nextRunAt: null,
      lastRunSummary: null,
      createdAt: ago(17),
      updatedAt: ago(12),
    },
  ]).returning();

  // ======================= connector runs =======================
  const runCounts = RUN_SPECS.map((_, i) => COMPANIES.filter((c) => c.run === i).length);
  const runRows: { id: bigint; startedAt: Date; spec: RunSpec }[] = [];
  for (const [i, spec] of RUN_SPECS.entries()) {
    const r = recipeSpec(spec.recipe);
    const startedAt = spec.status === 'running' ? ago(0, 0, 6) : ago(spec.startedDaysAgo, spec.startedHoursAgo ?? 0);
    const completedAt = spec.status === 'running' || spec.status === 'pending' ? null : plus(startedAt, spec.durationMin * MIN);
    const [row] = await db
      .insert(s.connectorRuns)
      .values({
        workspaceId: A,
        connectorId: connectorFor(r.connector),
        recipeId: recipeId(spec.recipe),
        productProfileIds: r.products.map((k) => P[k]),
        status: spec.status,
        progress: spec.status === 'succeeded' ? 100 : spec.status === 'running' ? (spec.progress ?? 40) : spec.status === 'failed' ? 60 : 10,
        recordCount: runCounts[i] ?? 0,
        startedAt,
        completedAt,
        errorPayload: spec.error
          ? { message: spec.error.message, payload: { code: spec.error.code, ...(spec.error.payload ?? {}) } }
          : spec.status === 'cancelled'
            ? { message: 'Cancelled by operator', payload: { cancelledBy: MEMBER_ID } }
            : null,
        recipeSnapshot: {
          name: r.name,
          seedUrls: r.seedUrls,
          searchQueries: r.queries,
          selectors: recipeSelectors(r),
          paginationRules: recipePagination(r),
          enrichmentRules: { fetchHomepage: true, extractContacts: r.connector !== 'tender' },
          normalizationMapping: r.connector === 'tender' ? { title: 'notice.title', buyer: 'notice.buyer.name' } : {},
          evidenceRules: { requireDomain: true, minSnippetLength: 40 },
          ...recipeSelectors(r),
        },
        createdAt: startedAt,
        updatedAt: completedAt ?? NOW,
      })
      .returning();
    runRows.push({ id: must(row, 'run').id, startedAt, spec });
  }

  // crawl plan last-tick summaries (shape written by crawl-engine)
  const runIdStr = (i: number): string => must(runRows[i], `run ${i}`).id.toString();
  const planSummaries: Record<string, unknown>[] = [
    { started: 1, skipped: 1, failed: 0, startedRuns: [runIdStr(8)], skippedRecipes: [recipeId('uk_tenders').toString()], failedRecipes: [], ranAt: ago(0, 0, 6).toISOString() },
    { started: 1, skipped: 0, failed: 1, startedRuns: [runIdStr(7)], skippedRecipes: [], failedRecipes: [{ recipeId: recipeId('pl_facade').toString(), error: 'SerpAPI 429 rate limit — backing off until next tick' }], ranAt: ago(2, 7).toISOString() },
    { started: 1, skipped: 0, failed: 0, startedRuns: [runIdStr(9)], skippedRecipes: [], failedRecipes: [], ranAt: ago(12, 1).toISOString() },
  ];
  for (const [i, plan] of planRows.entries()) {
    await db.update(s.crawlPlans).set({ lastRunSummary: planSummaries[i] ?? null }).where(eq(s.crawlPlans.id, plan.id));
  }

  // run logs
  const logRows: s.NewConnectorRunLog[] = [];
  for (const [i, run] of runRows.entries()) {
    const r = recipeSpec(run.spec.recipe);
    const n = runCounts[i] ?? 0;
    logRows.push({ runId: run.id, level: 'info', message: `run started: ${r.name}`, payload: { recipe: r.key }, createdAt: run.startedAt });
    if (r.queries.length > 0) {
      r.queries.slice(0, 3).forEach((q, qi) => {
        logRows.push({
          runId: run.id,
          level: 'info',
          message: `query ${qi + 1}/${Math.min(3, r.queries.length)}: "${q}"`,
          payload: { query: q, results: between(6, 10) },
          createdAt: plus(run.startedAt, (qi + 1) * 2 * MIN),
        });
      });
    } else {
      logRows.push({ runId: run.id, level: 'info', message: `crawling ${r.seedUrls.length} seed URL(s)`, payload: { seedUrls: r.seedUrls }, createdAt: plus(run.startedAt, MIN) });
    }
    if (run.spec.status === 'succeeded') {
      logRows.push({ runId: run.id, level: 'info', message: `harvested ${n} new record(s); ${between(1, 4)} duplicate(s) skipped`, payload: { inserted: n }, createdAt: plus(run.startedAt, run.spec.durationMin * MIN - MIN) });
      logRows.push({ runId: run.id, level: 'info', message: 'run complete', payload: {}, createdAt: plus(run.startedAt, run.spec.durationMin * MIN) });
    } else if (run.spec.status === 'failed') {
      logRows.push({ runId: run.id, level: 'warn', message: `partial results: ${n} record(s) saved before failure`, payload: { inserted: n }, createdAt: plus(run.startedAt, (run.spec.durationMin - 1) * MIN) });
      logRows.push({ runId: run.id, level: 'error', message: run.spec.error?.message ?? 'run failed', payload: run.spec.error?.payload ?? {}, createdAt: plus(run.startedAt, run.spec.durationMin * MIN) });
    } else if (run.spec.status === 'running') {
      logRows.push({ runId: run.id, level: 'info', message: `progress: query 2/4, ${n} record(s) so far`, payload: { current: 2, total: 4 }, createdAt: ago(0, 0, 2) });
    } else if (run.spec.status === 'cancelled') {
      logRows.push({ runId: run.id, level: 'warn', message: 'cancelled by operator before first page completed', payload: {}, createdAt: plus(run.startedAt, 2 * MIN) });
    }
  }
  await db.insert(s.connectorRunLogs).values(logRows);

  // ======================= source records + qualifications + review =======================
  const seeded: Seeded[] = [];
  const runOffsets = new Map<number, number>();

  for (const co of COMPANIES) {
    const run = must(runRows[co.run], `run ${co.run}`);
    const r = recipeSpec(co.recipe);
    const idx = runOffsets.get(co.run) ?? 0;
    runOffsets.set(co.run, idx + 1);
    const createdAt = plus(run.startedAt, (idx + 1) * 35_000);
    const primary: ProductKey = co.product ?? must(r.products[0], 'recipe primary product');
    const homepage = `https://www.${co.domain}/`;
    const query = r.queries.length > 0 ? r.queries[idx % r.queries.length] ?? null : null;
    const sourceUrl =
      r.connector === 'tender'
        ? `https://tenders.example.co.uk/notice/${2026}-${between(100000, 999999)}`
        : r.connector === 'directory'
          ? `https://directory.example.it/azienda/${co.domain.split('.')[0]}`
          : homepage;
    const snippet = co.blurb;
    const normalized: Record<string, unknown> = {
      title: co.name,
      companyName: co.name,
      url: homepage,
      domain: co.domain,
      snippet,
      ...(query ? { query, rank: idx + 1 } : {}),
      ...(co.city ? { city: co.city } : {}),
      ...(co.country ? { country: COUNTRY_NAME[co.country] } : {}),
      ...(r.connector === 'tender'
        ? {
            buyer: co.outcome === 'ignored' ? co.name : 'NHS Property Services (demo)',
            deadline: ahead(between(5, 25)).toISOString().slice(0, 10),
            estimatedValueGbp: between(80, 900) * 1000,
          }
        : {}),
    };
    const raw: Record<string, unknown> =
      r.connector === 'web'
        ? { source: 'serpapi', position: idx + 1, title: co.name, link: homepage, displayed_link: co.domain, snippet }
        : r.connector === 'directory'
          ? { entryId: `it-${hex(8)}`, name: co.name, website: homepage, address: { city: co.city, country: 'IT' }, categories: ['Coibentazioni', 'Antincendio'] }
          : { noticeId: `UKT-${hex(6).toUpperCase()}`, title: `Fire stopping remedial works — ${co.city ?? 'various sites'}`, supplierHint: co.name, cpv: ['45343000'] };

    const [sr] = await db
      .insert(s.sourceRecords)
      .values({
        workspaceId: A,
        sourceSystem: `connector:${connectorFor(r.connector).toString()}`,
        sourceId: `${r.key}:${co.domain}`,
        sourceUrl,
        connectorId: connectorFor(r.connector),
        recipeId: recipeId(co.recipe),
        runId: run.id,
        rawData: raw,
        normalizedData: normalized,
        evidenceUrls: [homepage, ...(sourceUrl !== homepage ? [sourceUrl] : [])],
        confidence: between(45, 85),
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    const sourceRecordId = must(sr, 'source record').id;

    // ---- qualifications (one per recipe product, primary first) ----
    const productsToQualify: ProductKey[] = [primary, ...r.products.filter((k) => k !== primary)];
    const qualIds = new Map<ProductKey, bigint>();
    for (const [pi, pk] of productsToQualify.entries()) {
      const isPrimary = pi === 0;
      const q = buildQualification(co, pk, isPrimary, r.country);
      const [qrow] = await db
        .insert(s.qualifications)
        .values({
          workspaceId: A,
          sourceRecordId,
          productProfileId: P[pk],
          ...q,
          createdAt: plus(createdAt, 40_000),
          updatedAt: plus(createdAt, 40_000),
        })
        .returning();
      qualIds.set(pk, must(qrow, 'qualification').id);
    }

    // ---- review item ----
    const reviewState: s.ReviewItemState =
      co.outcome === 'lead'
        ? 'approved'
        : co.outcome === 'new'
          ? 'new'
          : co.outcome === 'needs_review' || co.outcome === 'unverified'
            ? 'needs_review'
            : co.outcome === 'reject' || co.outcome === 'mismatch'
              ? 'rejected'
              : co.outcome;
    const plan = co.lead ? LEAD_PLANS[co.lead] : null;
    const decidedAt =
      reviewState === 'approved'
        ? ago(must(plan, 'lead plan').relevantAgo, 2)
        : reviewState === 'rejected' || reviewState === 'ignored' || reviewState === 'duplicate' || reviewState === 'archived'
          ? plus(createdAt, between(6, 40) * HOUR)
          : null;
    const decider = rand() < 0.6 ? MEMBER_ID : ADMIN_ID;
    const [ri] = await db
      .insert(s.reviewItems)
      .values({
        workspaceId: A,
        sourceRecordId,
        state: reviewState,
        assignedToUserId: reviewState === 'new' || reviewState === 'needs_review' ? (rand() < 0.5 ? MEMBER_ID : null) : plan?.assignee === 'admin' ? ADMIN_ID : plan?.assignee === 'member' ? MEMBER_ID : null,
        approvedByUserId: reviewState === 'approved' ? decider : null,
        approvedAt: reviewState === 'approved' ? decidedAt : null,
        approvalReason: reviewState === 'approved' ? pick(['Strong fit — industrial client base', 'Matches CUI programme profile', 'Good fit, right country', 'Installer with relevant references', null]) : null,
        rejectedByUserId: reviewState === 'rejected' && co.outcome === 'reject' ? decider : null,
        rejectedAt: reviewState === 'rejected' ? decidedAt : null,
        rejectionReason:
          reviewState === 'rejected'
            ? co.outcome === 'mismatch'
              ? `Outside target country (${co.country ?? '?'} vs ${r.country}) — auto-rejected by geo gate`
              : rejectionFor(co)
            : null,
        createdAt,
        updatedAt: decidedAt ?? createdAt,
      })
      .returning();
    seeded.push({
      co,
      sourceRecordId,
      reviewItemId: must(ri, 'review item').id,
      createdAt,
      primary,
      qualIds,
      reviewDecidedAt: decidedAt,
    });
  }

  // review comments
  const commentTargets = seeded.filter((x) => ['needs_review', 'unverified', 'new', 'reject'].includes(x.co.outcome)).slice(0, 9);
  await db.insert(s.reviewComments).values(
    commentTargets.flatMap((x, i) => [
      {
        workspaceId: A,
        reviewItemId: x.reviewItemId,
        userId: i % 2 === 0 ? MEMBER_ID : ADMIN_ID,
        comment: pick([
          'Website mentions refinery clients — worth a look.',
          'No address on the site; LinkedIn says Aberdeen? Need to confirm before outreach.',
          'Mostly residential work judging by the gallery. Leaning reject.',
          '@Jordan can you check if they are the same group as Insul8?',
          'Directory listing is 2 years old, check they still trade.',
          'They bid on the NHS framework last year — good sign.',
        ]),
        createdAt: plus(x.createdAt, between(3, 30) * HOUR),
      },
      ...(i % 3 === 0
        ? [{ workspaceId: A, reviewItemId: x.reviewItemId, userId: ADMIN_ID, comment: 'Agreed — keep in queue until we confirm location.', createdAt: plus(x.createdAt, 40 * HOUR) }]
        : []),
    ]),
  );

  console.log(`source records: ${seeded.length}`);

  await seedRest({
    A,
    B,
    C,
    P,
    PROD_LEGACY,
    PROD_B1,
    PROD_B2,
    CONN_B,
    CONN_WEB,
    recipeB: must(recipeB, 'recipe B').id,
    seeded,
    runRows,
    ADMIN_ID,
    MEMBER_ID,
    LENA_ID,
    PENDING_ID,
    SUSPENDED_ID,
    PILOT_ID,
  });
}

interface Seeded {
  co: CompanySpec;
  sourceRecordId: bigint;
  reviewItemId: bigint;
  createdAt: Date;
  primary: ProductKey;
  qualIds: Map<ProductKey, bigint>;
  reviewDecidedAt: Date | null;
}

interface RestCtx {
  A: bigint;
  B: bigint;
  C: bigint;
  P: Record<ProductKey, bigint>;
  PROD_LEGACY: bigint;
  PROD_B1: bigint;
  PROD_B2: bigint;
  CONN_B: bigint;
  CONN_WEB: bigint;
  recipeB: bigint;
  seeded: Seeded[];
  runRows: { id: bigint; startedAt: Date; spec: RunSpec }[];
  ADMIN_ID: string;
  MEMBER_ID: string;
  LENA_ID: string;
  PENDING_ID: string;
  SUSPENDED_ID: string;
  PILOT_ID: string;
}

// ---------------------------------------------------------------------------
// conversation content
// ---------------------------------------------------------------------------

type ReplyClass =
  | 'positive'
  | 'redirect'
  | 'question'
  | 'interest'
  | 'doc_request'
  | 'negative'
  | 'out_of_office'
  | 'bounce'
  | 'unsubscribe'
  | 'irrelevant';

type Lang = 'en' | 'pl' | 'de' | 'it';
const LANG_OF: Record<Country, Lang> = { GB: 'en', PL: 'pl', DE: 'de', IT: 'it' };

interface Text {
  /** What was actually sent / received (target language). */
  text: string;
  /** English reference (workspace native) when text is not English. */
  en?: string;
}

const shortName = (name: string): string =>
  name.replace(/\b(Ltd|GmbH|S\.r\.l\.|S\.p\.A\.|Sp\. z o\.o\.|S\.A\.)\b\.?/g, '').replace(/\s+—.*$/, '').trim();

function discoveryText(pk: ProductKey, lang: Lang, first: string, company: string, sender: string): { subject: Text; body: Text } {
  const co = shortName(company);
  const enAerogel = {
    subject: `Pipe insulation specs at ${co}`,
    body: `Hi ${first},\n\nQuick one — who at ${co} looks after insulation specs for CUI work and congested pipe racks?\n\nWe make 10 mm aerogel blankets (λ 0.021) that replace 40–50 mm of mineral wool, which usually means re-insulating without moving adjacent lines.\n\nHappy to send a one-page datasheet to the right person.\n\nBest,\n${sender}`,
  };
  const enSealant = {
    subject: `Penetration sealing on ${co} projects`,
    body: `Hi ${first},\n\nWho chooses the penetration sealing products on your fire stopping and remediation jobs?\n\nOur intumescent sealant is tested to EN 1366-3 for cable bundles and plastic pipes up to 110 mm (EI 120), and we run installer training with labelled penetration registers.\n\nCould I send the relevant test configuration summary to the right person?\n\nBest regards,\n${sender}`,
  };
  if (pk === 'wool') {
    return {
      subject: { text: `Izolacje fasad i obudów hal — ${co}` },
      body: {
        text: `Dzień dobry,\n\nkto w ${co} odpowiada za dobór izolacji do fasad wentylowanych i obudów hal?\n\nDostarczamy płyty z wełny mineralnej A1 (do EI 120 w systemach płyt warstwowych) z magazynu w Poznaniu w 48 h.\n\nChętnie prześlę kartę techniczną właściwej osobie.\n\nPozdrawiam serdecznie,\n${sender}`,
      },
    };
  }
  const en = pk === 'aerogel' ? enAerogel : enSealant;
  if (lang === 'de') {
    const de =
      pk === 'aerogel'
        ? {
            subject: `Rohrleitungsisolierung bei ${co}`,
            body: `Guten Tag ${first},\n\nkurze Frage: Wer ist bei ${co} für die Isolierspezifikation bei CUI-Projekten und engen Rohrbrücken zuständig?\n\nWir stellen 10-mm-Aerogelmatten (λ 0,021) her, die 40–50 mm Mineralwolle ersetzen – oft lässt sich so neu dämmen, ohne benachbarte Leitungen zu versetzen.\n\nGerne sende ich der richtigen Person ein einseitiges Datenblatt.\n\nMit freundlichen Grüßen\n${sender}`,
          }
        : {
            subject: `Abschottungen bei Projekten von ${co}`,
            body: `Guten Tag ${first},\n\nwer wählt bei Ihren Brandschutz- und Sanierungsprojekten die Produkte für Abschottungen aus?\n\nUnsere intumeszierende Dichtmasse ist nach EN 1366-3 für Kabelbündel und Kunststoffrohre bis 110 mm (EI 120) geprüft, und wir bieten Verarbeiterschulungen mit gekennzeichneten Abschottungsregistern an.\n\nDarf ich der zuständigen Person die passende Prüfkonfiguration schicken?\n\nMit freundlichen Grüßen\n${sender}`,
          };
    return { subject: { text: de.subject, en: en.subject }, body: { text: de.body, en: en.body } };
  }
  if (lang === 'it') {
    const it =
      pk === 'aerogel'
        ? {
            subject: `Specifiche di coibentazione presso ${co}`,
            body: `Buongiorno ${first},\n\nuna domanda veloce: chi si occupa in ${co} delle specifiche di coibentazione per interventi CUI e rack di tubazioni affollati?\n\nProduciamo materassini in aerogel da 10 mm (λ 0,021) che sostituiscono 40–50 mm di lana minerale, spesso senza dover spostare le linee adiacenti.\n\nSarei felice di inviare una scheda tecnica di una pagina alla persona giusta.\n\nCordiali saluti,\n${sender}`,
          }
        : {
            subject: `Sigillature antincendio nei progetti di ${co}`,
            body: `Buongiorno ${first},\n\nchi sceglie i prodotti per la sigillatura degli attraversamenti nei vostri cantieri di protezione passiva?\n\nIl nostro sigillante intumescente è testato secondo EN 1366-3 per fasci di cavi e tubi in plastica fino a 110 mm (EI 120) e offriamo formazione per gli installatori.\n\nPosso inviare la configurazione di prova pertinente alla persona giusta?\n\nCordiali saluti,\n${sender}`,
          };
    return { subject: { text: it.subject, en: en.subject }, body: { text: it.body, en: en.body } };
  }
  return { subject: { text: en.subject }, body: { text: en.body } };
}

function followUpText(step: number, lang: Lang, first: string, sender: string): Text {
  const en = [
    `Hi ${first},\n\nJust bumping this in case it got buried — is there someone else I should speak to about insulation specs?\n\nThanks,\n${sender}`,
    `Hi ${first},\n\nOne more thought: we recently helped a Teesside contractor re-insulate 600 m of cold lines in half the usual time. Happy to share the one-page case study or do a 15-minute call.\n\nBest,\n${sender}`,
    `Hi ${first},\n\nI'll assume the timing isn't right and won't keep chasing. If insulation specs come up later, just reply to this email and I'll pick it up.\n\nAll the best,\n${sender}`,
  ][step - 1] ?? '';
  if (lang === 'pl') {
    return {
      text: [
        `Dzień dobry,\n\nuprzejmie przypominam się z poprzednią wiadomością — czy jest ktoś, z kim powinienem porozmawiać o doborze izolacji?\n\nPozdrawiam,\n${sender}`,
        `Dzień dobry,\n\nniedawno dostarczyliśmy płyty A1 na obudowę centrum logistycznego pod Gdańskiem (12 000 m²). Chętnie prześlę krótkie studium przypadku lub umówię 15-minutową rozmowę.\n\nPozdrawiam,\n${sender}`,
        `Dzień dobry,\n\nzakładam, że to nie jest dobry moment, więc nie będę się więcej przypominać. Gdyby temat izolacji wrócił, wystarczy odpowiedzieć na tę wiadomość.\n\nPozdrawiam serdecznie,\n${sender}`,
      ][step - 1] ?? '',
      en,
    };
  }
  return { text: en };
}

interface ThreadEvent {
  t: 'discovery' | 'followup' | 'in' | 'out';
  at: Date;
  step?: number;
  stage?: s.OutreachStage;
  body?: Text;
  subjectOverride?: string;
  cls?: ReplyClass;
  conf?: number;
  extracted?: string[];
  fromName?: string;
  fromAddress?: string;
  opens?: number;
  bounced?: string;
  attachments?: { filename: string; contentType: string; sizeBytes: number }[];
}

interface FollowUpPlanRow {
  step: number;
  status: 'pending' | 'awaiting_approval' | 'sent' | 'skipped' | 'failed';
  scheduledFor: Date;
  processedAt?: Date;
  skipReason?: string;
  lastError?: string;
}

interface ThreadPlan {
  /** contact email this thread talks to */
  contactKey: string;
  mailbox: 'MB1' | 'MB2';
  events: ThreadEvent[];
  followUps: FollowUpPlanRow[];
  closed?: { at: Date; reason: string; referralTo?: string };
  referralChain?: { from_email: string; from_name: string; at: string }[];
}

/** Standard 3-step follow-up rows cancelled because the lead replied. */
const skippedFU = (contactedAgo: number, repliedAt: Date, sentSteps: number[] = []): FollowUpPlanRow[] =>
  [1, 2, 3].map((step) => {
    const scheduledFor = ago(contactedAgo - [4, 10, 18][step - 1]!);
    if (sentSteps.includes(step)) return { step, status: 'sent' as const, scheduledFor, processedAt: scheduledFor };
    return { step, status: 'skipped' as const, scheduledFor, processedAt: repliedAt, skipReason: 'replied' };
  });

// ---------------------------------------------------------------------------
// seedRest — everything downstream of review items
// ---------------------------------------------------------------------------

async function seedRest(ctx: RestCtx): Promise<void> {
  const { A, B, C, P, seeded, ADMIN_ID, MEMBER_ID, LENA_ID, PENDING_ID, SUSPENDED_ID } = ctx;
  const userFor = (a: 'admin' | 'member' | null): string | null => (a === 'admin' ? ADMIN_ID : a === 'member' ? MEMBER_ID : null);

  // ======================= mailboxes =======================
  const mbRows = await db
    .insert(s.mailboxes)
    .values([
      {
        workspaceId: A,
        name: `Sales · sales@${MAIL_DOMAIN}`,
        fromAddress: `sales@${MAIL_DOMAIN}`,
        fromName: 'Marta Zielonka · Northwind Insulation',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: `sales@${MAIL_DOMAIN}`,
        smtpPasswordSecretKey: `mailbox.smtpPassword_${hex(12)}`,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: `sales@${MAIL_DOMAIN}`,
        imapPasswordSecretKey: `mailbox.imapPassword_${hex(12)}`,
        imapFolder: 'INBOX',
        status: 'active',
        isDefault: true,
        lastSyncedAt: ago(0, 0, 4),
        imapEmptySyncs: 2,
        createdBy: ADMIN_ID,
        createdAt: ago(34),
        updatedAt: ago(0, 0, 4),
      },
      {
        workspaceId: A,
        name: `Jordan · jordan@${MAIL_DOMAIN}`,
        fromAddress: `jordan@${MAIL_DOMAIN}`,
        fromName: 'Jordan Avery',
        replyTo: `sales@${MAIL_DOMAIN}`,
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: `jordan@${MAIL_DOMAIN}`,
        smtpPasswordSecretKey: `mailbox.smtpPassword_${hex(12)}`,
        imapHost: 'imap.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: `jordan@${MAIL_DOMAIN}`,
        imapPasswordSecretKey: `mailbox.imapPassword_${hex(12)}`,
        status: 'active',
        isDefault: false,
        lastSyncedAt: ago(0, 0, 9),
        imapEmptySyncs: 6,
        createdBy: ADMIN_ID,
        createdAt: ago(30),
        updatedAt: ago(0, 0, 9),
      },
      {
        workspaceId: A,
        name: 'Legacy outreach · outreach@northwind-mail.example.com',
        fromAddress: 'outreach@northwind-mail.example.com',
        fromName: 'Northwind Insulation',
        smtpHost: 'mail.northwind-mail.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'outreach@northwind-mail.example.com',
        smtpPasswordSecretKey: `mailbox.smtpPassword_${hex(12)}`,
        imapHost: 'mail.northwind-mail.example.com',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'outreach@northwind-mail.example.com',
        imapPasswordSecretKey: `mailbox.imapPassword_${hex(12)}`,
        status: 'failing',
        isDefault: false,
        lastSyncedAt: ago(3, 5),
        lastError: 'IMAP: AUTHENTICATIONFAILED Invalid credentials (password changed on the server?)',
        imapConsecutiveFailures: 4,
        imapNextSyncAfter: ahead(0, 0, 32),
        createdBy: ADMIN_ID,
        createdAt: ago(37),
        updatedAt: ago(0, 1),
      },
    ])
    .returning();
  const MB1 = must(mbRows[0], 'mb1');
  const MB2 = must(mbRows[1], 'mb2');
  const MB3 = must(mbRows[2], 'mb3');
  const mbByKey = { MB1, MB2 } as const;
  const senderOf = (mb: typeof MB1): string => (mb.id === MB1.id ? 'Marta Zielonka\nNorthwind Insulation' : 'Jordan Avery\nNorthwind Insulation');

  const today = NOW.toISOString().slice(0, 10);
  await db.insert(s.mailboxSendingLimits).values([
    {
      mailboxId: MB1.id,
      workspaceId: A,
      maxPerDay: 60,
      maxPerHour: 12,
      maxPerDomain: 3,
      minDelaySeconds: 90,
      maxDelaySeconds: 420,
      businessHoursOnly: true,
      businessStartHour: 8,
      businessEndHour: 17,
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'Europe/London',
      respectWeekends: true,
      respectHolidays: true,
      holidayCountry: 'GB',
      sentToday: 7,
      sentThisHour: 1,
      lastResetDate: today,
      lastResetHour: NOW.getUTCHours(),
      updatedAt: ago(0, 0, 30),
    },
    {
      mailboxId: MB2.id,
      workspaceId: A,
      maxPerDay: 40,
      maxPerHour: 8,
      maxPerDomain: 2,
      minDelaySeconds: 120,
      maxDelaySeconds: 600,
      businessHoursOnly: true,
      businessStartHour: 9,
      businessEndHour: 18,
      businessDays: [1, 2, 3, 4, 5],
      timezone: 'Europe/Berlin',
      holidayCountry: 'DE',
      sentToday: 2,
      sentThisHour: 0,
      lastResetDate: today,
      lastResetHour: NOW.getUTCHours(),
      updatedAt: ago(0, 2),
    },
    { mailboxId: MB3.id, workspaceId: A, maxPerDay: 20, maxPerHour: 5, updatedAt: ago(20) },
  ]);

  await db.insert(s.outreachSendSettings).values({
    workspaceId: A,
    dailyEmailLimit: 60,
    domainCooldownHours: 48,
    defaultDelayMode: 'random',
    fixedDelayMinutes: 15,
    randomDelayMinMinutes: 4,
    randomDelayMaxMinutes: 25,
    emergencyPause: false,
    updatedBy: ADMIN_ID,
    updatedAt: ago(12),
  });
  await db.insert(s.replyAutoActions).values({
    workspaceId: A,
    autoSuppressBounce: true,
    autoSuppressUnsubscribe: true,
    autoCloseNegative: true,
    autoExtractRedirects: true,
    updatedBy: ADMIN_ID,
    updatedAt: ago(15),
  });

  await db.insert(s.signatures).values([
    {
      workspaceId: A,
      mailboxId: MB1.id,
      name: 'Marta — sales (EN)',
      bodyText: 'Best regards,\nMarta Zielonka\nBusiness Development Manager · Northwind Insulation\n+44 7700 900461 · northwind-insulation.example.com',
      greeting: 'Best regards,',
      fullName: 'Marta Zielonka',
      title: 'Business Development Manager',
      company: 'Northwind Insulation',
      tagline: 'Thin insulation for tight spaces',
      website: 'https://northwind-insulation.example.com',
      email: `sales@${MAIL_DOMAIN}`,
      phones: [
        { label: 'Mobile', number: '+44 7700 900461' },
        { label: 'Office', number: '+44 20 7946 0958' },
      ],
      isDefault: true,
      createdBy: MEMBER_ID,
      createdAt: ago(33),
      updatedAt: ago(9),
    },
    {
      workspaceId: A,
      mailboxId: MB2.id,
      name: 'Jordan — DACH / Italy',
      bodyText: 'Kind regards,\nJordan Avery\nHead of Export Sales · Northwind Insulation\n+44 7700 900874',
      greeting: 'Kind regards,',
      fullName: 'Jordan Avery',
      title: 'Head of Export Sales',
      company: 'Northwind Insulation',
      website: 'https://northwind-insulation.example.com',
      email: `jordan@${MAIL_DOMAIN}`,
      phones: [{ label: 'Mobile', number: '+44 7700 900874' }],
      isDefault: true,
      createdBy: ADMIN_ID,
      createdAt: ago(29),
      updatedAt: ago(29),
    },
    {
      workspaceId: A,
      mailboxId: null,
      name: 'Polski podpis (workspace)',
      bodyText: 'Pozdrawiam serdecznie,\nMarta Zielonka\nNorthwind Insulation — dział sprzedaży PL\n+48 600 000 000',
      greeting: 'Pozdrawiam serdecznie,',
      fullName: 'Marta Zielonka',
      title: 'Kierownik ds. rozwoju sprzedaży',
      company: 'Northwind Insulation',
      phones: [{ label: 'Tel.', number: '+48 600 000 000' }],
      isDefault: false,
      createdBy: MEMBER_ID,
      createdAt: ago(20),
      updatedAt: ago(20),
    },
  ]);

  // ======================= contacts + leads =======================
  const emailOf = (first: string, last: string, domain: string): string =>
    `${asciiFold(first).toLowerCase()}.${asciiFold(last).toLowerCase().replace(/[^a-z]/g, '')}@${domain}`;
  const phoneFor = (c: Country | null): string | null =>
    c === 'GB' ? `+44 7700 900${between(100, 999)}` : c === 'PL' ? `+48 22 ${between(100, 999)} 00 00` : c === 'DE' ? `+49 30 ${between(1000000, 9999999)}` : c === 'IT' ? `+39 02 ${between(1000000, 9999999)}` : null;

  interface ContactInfo {
    id: bigint;
    email: string;
    name: string;
    role: string;
    first: string;
    last: string;
  }
  const contactByEmail = new Map<string, ContactInfo>();
  async function addContact(v: {
    first: string;
    last: string;
    role: string;
    domain: string;
    company: string;
    country: Country | null;
    tags: string[];
    createdAt: Date;
    status?: 'active' | 'archived';
    notes?: string;
    createdBy?: string | null;
    emailOverride?: string;
  }): Promise<ContactInfo> {
    const email = v.emailOverride ?? emailOf(v.first, v.last, v.domain);
    const [row] = await db
      .insert(s.contacts)
      .values({
        workspaceId: A,
        email,
        name: `${v.first} ${v.last}`.trim(),
        role: v.role,
        phone: phoneFor(v.country),
        companyName: v.company,
        companyDomain: v.domain,
        status: v.status ?? 'active',
        notes: v.notes ?? null,
        tags: v.tags,
        metadata: {
          source: 'review_approval',
          linkedinUrl: `https://www.linkedin.example.com/in/${asciiFold(v.first).toLowerCase()}-${asciiFold(v.last).toLowerCase()}-demo`,
          ...(v.country ? { country: v.country } : {}),
        },
        createdBy: v.createdBy === undefined ? MEMBER_ID : v.createdBy,
        createdAt: v.createdAt,
        updatedAt: plus(v.createdAt, between(1, 72) * HOUR),
      })
      .returning();
    const info: ContactInfo = { id: must(row, 'contact').id, email, name: `${v.first} ${v.last}`.trim(), role: v.role, first: v.first, last: v.last };
    contactByEmail.set(email, info);
    return info;
  }
  const associations: s.NewContactAssociation[] = [];
  const assoc = (contactId: bigint, entityType: string, entityId: bigint, relation: string | null, at: Date): void => {
    associations.push({ workspaceId: A, contactId, entityType, entityId: entityId.toString(), relation, createdAt: at });
  };

  interface LeadInfo {
    key: LeadKey;
    id: bigint;
    sd: Seeded;
    plan: LeadPlan;
    product: ProductKey;
    lang: Lang;
    contact: ContactInfo;
    /** for referral leads: the original contact */
    originalContact?: ContactInfo;
  }
  const leads = new Map<LeadKey, LeadInfo>();
  const REFERRALS: Partial<Record<LeadKey, [string, string, string]>> = {
    P4: ['Ryan', 'Mitchell', 'Fire Stopping Contracts Lead'],
    I1: ['Laura', 'Bennett', 'Insulation Package Manager'],
  };

  for (const sd of seeded) {
    const co = sd.co;
    if (!co.lead) continue;
    const plan = LEAD_PLANS[co.lead];
    const [first, last, role] = must(co.contact, `contact for ${co.name}`);
    const country = must(co.country, 'lead country');
    const original = await addContact({
      first,
      last,
      role,
      domain: co.domain,
      company: co.name,
      country,
      tags: [...plan.tags.filter((t) => t !== 'priority'), country.toLowerCase()],
      createdAt: plus(sd.createdAt, 2 * DAY),
    });
    let current = original;
    const ref = REFERRALS[co.lead];
    if (ref) {
      current = await addContact({
        first: ref[0],
        last: ref[1],
        role: ref[2],
        domain: co.domain,
        company: co.name,
        country,
        tags: ['referral', country.toLowerCase()],
        createdAt: ago(plan.repliedAgo ?? plan.contactedAgo ?? 1),
        notes: `Referred by ${first} ${last} (${role}).`,
        createdBy: null,
      });
    }
    const relevantAt = ago(plan.relevantAgo, 2);
    const closedAt = plan.closedAgo !== undefined ? ago(plan.closedAgo, 1) : null;
    const stage =
      plan.state === 'relevant' || plan.state === 'contacted'
        ? 'discovery'
        : plan.state === 'replied' || plan.state === 'contact_identified'
          ? 'engagement'
          : plan.state === 'qualified'
            ? 'pitch'
            : 'closing';
    const [row] = await db
      .insert(s.qualifiedLeads)
      .values({
        workspaceId: A,
        reviewItemId: sd.reviewItemId,
        productProfileId: P[sd.primary],
        state: plan.state,
        contactName: current.name,
        contactEmail: current.email,
        contactRole: current.role,
        contactPhone: phoneFor(country),
        contactNotes: ref ? `Original contact ${first} ${last} redirected us.` : null,
        assignedToUserId: userFor(plan.assignee),
        relevantAt,
        contactedAt: plan.contactedAgo !== undefined ? ago(plan.contactedAgo, 5) : null,
        repliedAt: plan.repliedAgo !== undefined ? ago(plan.repliedAgo, 2) : null,
        contactIdentifiedAt: plan.identifiedAgo !== undefined ? ago(plan.identifiedAgo, 1) : null,
        qualifiedAt: plan.qualifiedAgo !== undefined ? ago(plan.qualifiedAgo, 1) : null,
        handedOverAt: plan.handedAgo !== undefined ? ago(plan.handedAgo, 1) : null,
        syncedAt: plan.syncedAgo !== undefined ? ago(plan.syncedAgo, 1) : null,
        closedAt,
        closeReason: plan.closeReason ?? null,
        closeNote: plan.closeNote ?? null,
        currentStage: stage,
        currentContactEmail: current.email,
        outreachLanguage: co.lead === 'R5' ? 'it' : null,
        crmExternalId: plan.state === 'synced_to_crm' || co.lead === 'H1' ? `${between(10000000, 99999999)}` : null,
        crmSystem: plan.state === 'synced_to_crm' || co.lead === 'H1' ? 'hubspot' : null,
        notes: plan.notes ?? null,
        tags: plan.tags,
        createdBy: sd.co.outcome === 'lead' ? MEMBER_ID : null,
        createdAt: relevantAt,
        updatedAt: closedAt ?? ago(Math.min(plan.relevantAgo, plan.repliedAgo ?? 99, plan.contactedAgo ?? 99), 0, 30),
      })
      .returning();
    const lead: LeadInfo = {
      key: co.lead,
      id: must(row, 'lead').id,
      sd,
      plan,
      product: sd.primary,
      lang: LANG_OF[country],
      contact: current,
      ...(ref ? { originalContact: original } : {}),
    };
    leads.set(co.lead, lead);
    assoc(original.id, 'qualified_lead', lead.id, 'primary', relevantAt);
    if (ref) assoc(current.id, 'qualified_lead', lead.id, 'primary', ago(plan.repliedAgo ?? 1));
    assoc(original.id, 'source_record', sd.sourceRecordId, null, relevantAt);
  }
  const L = (k: LeadKey): LeadInfo => must(leads.get(k), `lead ${k}`);

  // prospects (not yet leads), archived + external contacts
  for (const sd of seeded) {
    if (sd.co.lead || !sd.co.contact) continue;
    const [first, last, role] = sd.co.contact;
    const c = await addContact({
      first,
      last,
      role,
      domain: sd.co.domain,
      company: sd.co.name,
      country: sd.co.country,
      tags: ['prospect'],
      createdAt: plus(sd.createdAt, 3 * HOUR),
      createdBy: null,
    });
    assoc(c.id, 'source_record', sd.sourceRecordId, null, plus(sd.createdAt, 3 * HOUR));
  }
  await addContact({ first: 'Graham', last: 'Pike', role: 'Former Buyer', domain: 'brunel-thermal.example.co.uk', company: 'Brunel Thermal Contracting', country: 'GB', tags: ['left-company'], createdAt: ago(26), status: 'archived', notes: 'Left Brunel in September — use Tom Ashworth.' });
  await addContact({ first: 'Info', last: 'Hansa', role: 'Generic inbox', domain: 'hansa-daemmtechnik.example.de', company: 'Hansa Dämmtechnik GmbH', country: 'DE', tags: ['generic-inbox'], createdAt: ago(17), status: 'archived', emailOverride: 'info@hansa-daemmtechnik.example.de' });
  const expoContact = await addContact({ first: 'Events', last: 'Team', role: 'Exhibitor services', domain: 'insulation-expo.example.co.uk', company: 'Insulation Expo 2026', country: 'GB', tags: ['event', 'vendor'], createdAt: ago(6), emailOverride: 'events@insulation-expo.example.co.uk', createdBy: null });
  await addContact({ first: 'Jan', last: 'Kowal', role: 'Kierownik handlowy', domain: 'hurtownia-izolacji.example.pl', company: 'Hurtownia Izolacji Kowal', country: 'PL', tags: ['distributor', 'partner'], createdAt: ago(19), notes: 'Potential distributor for wool panels in Mazowsze.' });
  await addContact({ first: 'Chiara', last: 'Fontana', role: 'Agente di commercio', domain: 'fontana-rappresentanze.example.it', company: 'Fontana Rappresentanze', country: 'IT', tags: ['agent', 'partner'], createdAt: ago(15), notes: 'Independent agent covering Lombardy; interested in sealants.' });

  // ======================= drafts / queue / threads / messages =======================
  const draftsByLead = new Map<LeadKey, bigint[]>();
  const leadThreads = new Map<LeadKey, { threadId: bigint; state: ThreadPlan; lastMsgId: string }[]>();
  const queueRows: s.NewOutreachQueueEntry[] = [];
  const emailOpenRows: s.NewEmailOpenEvent[] = [];
  const followUpRows: s.NewOutreachFollowUp[] = [];
  const threadStateIds = new Map<bigint, bigint>();

  async function insertDraft(lead: LeadInfo, v: {
    stage: s.OutreachStage;
    subject: Text;
    body: Text;
    at: Date;
    triggeredBy?: bigint | null;
    referralChain?: ThreadPlan['referralChain'];
    method?: 'ai' | 'rules' | 'hybrid';
    confidence?: number;
  }): Promise<bigint> {
    const translated = v.body.en !== undefined;
    const [row] = await db
      .insert(s.outreachDrafts)
      .values({
        workspaceId: A,
        reviewItemId: lead.sd.reviewItemId,
        sourceRecordId: lead.sd.sourceRecordId,
        productProfileId: P[lead.product],
        qualificationId: lead.sd.qualIds.get(lead.product) ?? null,
        status: 'superseded',
        stage: v.stage,
        triggeredByMessageId: v.triggeredBy ?? null,
        referralChain: v.referralChain ?? null,
        channel: 'email',
        language: translated ? 'en' : lead.lang,
        subject: translated ? (v.subject.en ?? v.subject.text) : v.subject.text,
        body: translated ? (v.body.en ?? v.body.text) : v.body.text,
        subjectTranslated: translated ? v.subject.text : null,
        bodyTranslated: translated ? v.body.text : null,
        targetLanguage: translated ? lead.lang : null,
        confidence: v.confidence ?? between(68, 92),
        method: v.method ?? 'ai',
        model: v.method === 'rules' ? null : pick(['gpt-5-mini', 'claude-sonnet-4-6', 'gpt-5-mini']),
        evidence: {
          stage: v.stage,
          productSnapshot: { name: PRODUCT_LABEL[lead.product] },
          researchUsed: lead.product === 'aerogel',
          lessonIds: [],
        },
        forbiddenStripped: rand() < 0.15 ? ['game-changer'] : [],
        createdBy: null,
        createdAt: v.at,
        updatedAt: v.at,
      })
      .returning();
    const id = must(row, 'draft').id;
    draftsByLead.set(lead.key, [...(draftsByLead.get(lead.key) ?? []), id]);
    return id;
  }

  async function insertMsg(v: s.NewMailMessage): Promise<bigint> {
    const [row] = await db.insert(s.mailMessages).values(v).returning({ id: s.mailMessages.id });
    return must(row, 'mail message').id;
  }

  async function buildThread(lead: LeadInfo, plan: ThreadPlan, contact: ContactInfo): Promise<void> {
    const mb = mbByKey[plan.mailbox];
    const sender = senderOf(mb);
    const company = lead.sd.co.name;
    const disc = discoveryText(lead.product, lead.lang, contact.first, company, sender);
    const rootId = newMessageId();
    const subject = disc.subject.text;
    const firstAt = must(plan.events[0], 'first event').at;
    const [th] = await db
      .insert(s.mailThreads)
      .values({
        workspaceId: A,
        mailboxId: mb.id,
        subject,
        externalThreadKey: rootId,
        messageCount: 0,
        lastMessageAt: firstAt,
        participants: [mb.fromAddress.toLowerCase(), contact.email],
        createdAt: firstAt,
        updatedAt: firstAt,
      })
      .returning();
    const threadId = must(th, 'thread').id;
    assoc(contact.id, 'mail_thread', threadId, 'primary', firstAt);

    const refs: string[] = [];
    let lastMsgId = rootId;
    let lastInbound: { id: bigint; at: Date; cls: ReplyClass; conf: number } | null = null;
    let lastOutboundAt: Date | null = null;
    let count = 0;
    let lastAt = firstAt;
    let stage: s.OutreachStage = 'discovery';
    const participants = new Set<string>([mb.fromAddress.toLowerCase(), contact.email]);

    for (const ev of plan.events) {
      const isFirst = count === 0;
      const messageId = isFirst ? rootId : newMessageId();
      const inReplyTo = isFirst ? null : lastMsgId;
      const references = isFirst ? [] : [...refs];
      if (ev.t === 'in') {
        const fromAddress = ev.fromAddress ?? contact.email;
        participants.add(fromAddress.toLowerCase());
        const foreign = ev.body?.en !== undefined;
        const id = await insertMsg({
          workspaceId: A,
          mailboxId: mb.id,
          threadId,
          direction: 'inbound',
          status: 'received',
          messageId,
          inReplyTo,
          references,
          fromAddress,
          fromName: ev.fromName ?? contact.name,
          toAddresses: [mb.fromAddress],
          subject: ev.subjectOverride ?? `${ev.cls === 'out_of_office' ? 'Automatic reply' : ev.cls === 'bounce' ? 'Delivery Status Notification (Failure)' : 'Re'}: ${subject}`,
          bodyText: ev.body?.text ?? '',
          headers: { 'Content-Language': foreign ? lead.lang : 'en', 'X-Mailer': pick(['Microsoft Outlook 16.0', 'Apple Mail (2.3774)', 'Gmail']) },
          attachments: ev.attachments ?? [],
          receivedAt: ev.at,
          contactId: ev.cls === 'bounce' ? null : (contactByEmail.get(fromAddress)?.id ?? contact.id),
          replyClassification: ev.cls ?? null,
          replyClassificationConfidence: ev.conf ?? null,
          replyClassifiedAt: ev.cls ? plus(ev.at, MIN) : null,
          extractedEmails: ev.extracted ?? [],
          bodyTextNative: foreign ? (ev.body?.en ?? null) : null,
          nativeLanguage: foreign ? 'en' : null,
          translatedFromLanguage: foreign ? lead.lang : null,
          targetLanguage: null,
          translatedAt: foreign ? plus(ev.at, 2 * MIN) : null,
          createdAt: ev.at,
          updatedAt: ev.at,
        });
        if (ev.cls !== 'bounce') assoc(contactByEmail.get(fromAddress)?.id ?? contact.id, 'mail_message', id, 'inbound_sender', ev.at);
        lastInbound = { id, at: ev.at, cls: must(ev.cls, 'cls'), conf: ev.conf ?? 80 };
      } else {
        // outbound — discovery / follow-up / staged reply
        let body: Text;
        let subj: Text;
        let draftId: bigint | null = null;
        if (ev.t === 'discovery') {
          subj = disc.subject;
          body = disc.body;
          draftId = await insertDraft(lead, {
            stage: 'discovery',
            subject: subj,
            body,
            at: plus(ev.at, -between(6, 30) * HOUR),
            ...(plan.referralChain ? { referralChain: plan.referralChain } : {}),
          });
        } else if (ev.t === 'followup') {
          subj = { text: `Re: ${subject}`, ...(disc.subject.en ? { en: `Re: ${disc.subject.en}` } : {}) };
          body = followUpText(must(ev.step, 'step'), lead.lang, contact.first, sender);
        } else {
          stage = ev.stage ?? 'engagement';
          subj = { text: `Re: ${subject}`, ...(disc.subject.en ? { en: `Re: ${disc.subject.en}` } : {}) };
          body = must(ev.body, 'out body');
          draftId = await insertDraft(lead, {
            stage,
            subject: subj,
            body,
            at: plus(ev.at, -between(1, 5) * HOUR),
            triggeredBy: lastInbound?.id ?? null,
          });
        }
        const foreign = body.en !== undefined;
        const opens = ev.opens ?? (rand() < 0.55 ? between(1, 3) : 0);
        const token = hex(24);
        const sentAt = ev.at;
        const status: s.MailStatus = ev.bounced ? 'bounced' : sentAt.getTime() < ago(2).getTime() ? 'delivered' : 'sent';
        const id = await insertMsg({
          workspaceId: A,
          mailboxId: mb.id,
          threadId,
          direction: 'outbound',
          status,
          messageId,
          inReplyTo,
          references,
          fromAddress: mb.fromAddress,
          fromName: mb.fromName,
          toAddresses: [contact.email],
          subject: subj.text,
          bodyText: body.text,
          headers: {
            ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: references.join(' ') } : {}),
            'List-Unsubscribe': `<https://discover.example.com/api/unsubscribe/${token}>, <mailto:${mb.fromAddress}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          attachments: [],
          sentAt,
          deliveredAt: status === 'delivered' ? plus(sentAt, 40_000) : null,
          failureReason: ev.bounced ?? null,
          sourceDraftId: draftId,
          contactId: contact.id,
          trackingToken: token,
          openCount: ev.bounced ? 0 : opens,
          firstOpenedAt: !ev.bounced && opens > 0 ? plus(sentAt, between(20, 600) * MIN) : null,
          bodyTextNative: foreign ? (body.en ?? null) : null,
          nativeLanguage: foreign ? 'en' : null,
          targetLanguage: foreign ? lead.lang : null,
          createdBy: lead.plan.assignee === 'admin' ? ADMIN_ID : MEMBER_ID,
          createdAt: sentAt,
          updatedAt: sentAt,
        });
        if (!ev.bounced) {
          for (let i = 0; i < opens; i++) {
            emailOpenRows.push({
              workspaceId: A,
              messageId: id,
              token,
              userAgent: pick(['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Outlook/16.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mail', 'GoogleImageProxy']),
              ipHash: hex(16),
              openedAt: plus(sentAt, (i + 1) * between(20, 900) * MIN),
            });
          }
        }
        queueRows.push({
          workspaceId: A,
          mailboxId: mb.id,
          draftId,
          toAddresses: [contact.email],
          subject: subj.text,
          bodyText: body.text,
          inReplyTo,
          references,
          status: 'sent',
          delayMode: 'random',
          scheduledSendAt: plus(sentAt, -between(3, 25) * MIN),
          attemptCount: 1,
          sentMessageId: id,
          createdBy: lead.plan.assignee === 'admin' ? ADMIN_ID : MEMBER_ID,
          createdAt: plus(sentAt, -between(30, 180) * MIN),
          updatedAt: sentAt,
        });
        if (ev.t === 'followup') {
          const fu = plan.followUps.find((f) => f.step === ev.step);
          if (fu) {
            fu.processedAt = sentAt;
            (fu as FollowUpPlanRow & { sentMessageId?: bigint }).sentMessageId = id;
          }
        }
        lastOutboundAt = sentAt;
      }
      refs.push(messageId);
      lastMsgId = messageId;
      lastAt = ev.at;
      count += 1;
    }

    await db
      .update(s.mailThreads)
      .set({ messageCount: count, lastMessageAt: lastAt, participants: [...participants], updatedAt: lastAt })
      .where(eqId(s.mailThreads.id, threadId));

    const [ts] = await db
      .insert(s.outreachThreadState)
      .values({
        workspaceId: A,
        qualifiedLeadId: lead.id,
        threadId,
        stage: plan.closed ? (plan.closed.reason === 'handed_off' ? stage : 'closing') : stage,
        lastInboundIntent: lastInbound?.cls ?? null,
        lastInboundConfidence: lastInbound?.conf ?? null,
        lastInboundAt: lastInbound?.at ?? null,
        lastOutboundAt,
        closedAt: plan.closed?.at ?? null,
        closedReason: plan.closed?.reason ?? null,
        referralToEmail: plan.closed?.referralTo ?? null,
        createdAt: firstAt,
        updatedAt: lastAt,
      })
      .returning();
    threadStateIds.set(threadId, must(ts, 'thread state').id);

    for (const fu of plan.followUps) {
      followUpRows.push({
        workspaceId: A,
        qualifiedLeadId: lead.id,
        threadId,
        stepNumber: fu.step,
        totalSteps: 3,
        scheduledFor: fu.scheduledFor,
        status: fu.status,
        skipReason: fu.skipReason ?? null,
        lastError: fu.lastError ?? null,
        sentMessageId: (fu as FollowUpPlanRow & { sentMessageId?: bigint }).sentMessageId ?? null,
        stagedSubject: fu.status === 'awaiting_approval' ? `Re: ${subject}` : null,
        stagedBody: fu.status === 'awaiting_approval' ? followUpText(fu.step, lead.lang, contact.first, sender).text : null,
        processedAt: fu.processedAt ?? null,
        createdAt: firstAt,
        updatedAt: fu.processedAt ?? firstAt,
      });
    }

    leadThreads.set(lead.key, [...(leadThreads.get(lead.key) ?? []), { threadId, state: plan, lastMsgId }]);
  }

  // ---- inbound reply texts ----
  const RE = {
    C4_ooo: { text: 'Thank you for your email. I am out of the office on site visits until Monday with limited access to email. For urgent matters please call the office on +44 20 7946 0321.\n\nGareth Pryce' },
    P1_pos: { text: "Hi Marta,\n\nTiming is actually good. We're re-insulating about 400 m of 150 mm cold lines at the Saltend site in Q1 and space on the rack is tight. Can you send the AG10 datasheet and indicative pricing for 10 mm?\n\nThanks,\nSarah" },
    P2_q: {
      text: 'Dzień dobry,\n\njaka jest minimalna ilość zamówienia i czy płyty 90 kg/m³ mają klasyfikację EI 120 w systemie z blachą trapezową?\n\nPozdrawiam,\nAgnieszka Zielińska',
      en: 'Hello,\n\nwhat is the minimum order quantity, and do the 90 kg/m³ panels hold an EI 120 classification in a system with trapezoidal sheet?\n\nRegards,\nAgnieszka Zielińska',
    },
    P3_doc: {
      text: 'Guten Tag,\n\nbitte senden Sie uns das technische Datenblatt und die Leistungserklärung für AG10. Wir prüfen gerade Alternativen für eine Kälteleitung im Kraftwerk.\n\nMit freundlichen Grüßen\nMarkus Becker',
      en: 'Hello,\n\nplease send us the technical datasheet and the declaration of performance for AG10. We are currently evaluating alternatives for a cold line at the power plant.\n\nKind regards,\nMarkus Becker',
    },
    P4_redirect: { text: "Hi,\n\nI'm not the right person for this — please contact Ryan Mitchell, who runs our fire stopping contracts: ryan.mitchell@capital-pfp.example.co.uk\n\nThanks,\nEmma" },
    I1_redirect: { text: 'Hi Marta,\n\nInsulation packages are handled by Laura Bennett now (laura.bennett@teesside-lagging.example.co.uk). I have copied her in.\n\nCheers,\nNeil' },
    I1_interest: { text: "Thanks Marta — we do have a CUI package coming up at Wilton next year. Not ready to buy yet, but I'd be happy to look at a sample roll.\n\nLaura" },
    I2_interest: {
      text: 'Buongiorno,\n\nsiamo interessati. Il prodotto è certificato secondo EN 1366-3 per tubi in PVC fino a 110 mm? Abbiamo un cantiere ospedaliero a Padova in partenza a gennaio.\n\nCordiali saluti,\nLuca Esposito',
      en: 'Good morning,\n\nwe are interested. Is the product certified to EN 1366-3 for PVC pipes up to 110 mm? We have a hospital site in Padua starting in January.\n\nKind regards,\nLuca Esposito',
    },
    Q1_pos1: { text: "Hi Marta,\n\nYes — that's me. We have a 2 km steam main replacement at a distillery in Speyside next spring and the pipe bridge is very congested. Could we have a quick call this week?\n\nFiona" },
    Q1_pos2: { text: 'Thursday 10:00 works. Teams invite to fiona.gallagher@clydeside-thermal.example.co.uk please.\n\nF.' },
    Q2_pos: {
      text: 'Dzień dobry,\n\ntemat jest aktualny — rozbudowujemy halę technologiczną w Płocku. Proszę o próbki płyt 110 kg/m³ i cennik dla ok. 4 000 m².\n\nKrzysztof Mazur',
      en: 'Hello,\n\nthe topic is relevant — we are extending a process hall in Płock. Please send samples of the 110 kg/m³ panels and a price list for approx. 4,000 m².\n\nKrzysztof Mazur',
    },
    Q3_pos: {
      text: 'Hallo,\n\nwir bauen gerade ein neues Rechenzentrum in Frankfurt-Fechenheim. Ihre Abschottung für Kabelbündel klingt interessant – können wir die Prüfberichte und Muster bekommen?\n\nViele Grüße\nJulia Hoffmann',
      en: 'Hello,\n\nwe are building a new data centre in Frankfurt-Fechenheim. Your cable bundle sealing sounds interesting — could we get the test reports and samples?\n\nBest regards,\nJulia Hoffmann',
    },
    H1_pos1: { text: "Hi Marta,\n\nThis is relevant — we're planning the next CUI campaign on the boil-off gas lines. Can your sales engineer visit the site?\n\nDaniel" },
    H1_pos2: { text: 'Thanks for the comparison sheet. Ben can come on the 14th; please send him the induction forms attached to my next email.\n\nDaniel' },
    H2_pos: {
      text: 'Dzień dobry,\n\nprzygotowujemy obudowę nowej hali serwerowni pod Warszawą (ok. 9 000 m² ścian). Proszę o kontakt z naszym działem zakupów w przyszłym tygodniu.\n\nPaweł Kamiński',
      en: 'Hello,\n\nwe are preparing the envelope of a new server hall near Warsaw (approx. 9,000 m² of walls). Please contact our purchasing department next week.\n\nPaweł Kamiński',
    },
    S1_pos1: { text: 'Hi Marta,\n\nInteresting. We have a topside CUI programme starting in November — can you quote 2,000 m² of AG10?\n\nIan McLeod' },
    S1_pos2: { text: "Thanks Marta — pricing looks fine. We'll add Northwind to our approved supplier list; please register on our vendor portal.\n\nIan" },
    X1_pos1: { text: 'Hi Marta, good timing — we have a retrofit at Avonmouth where mineral wool simply will not fit. Send pricing please.\n\nTom' },
    X1_pos2: { text: 'Tom here — PO attached for 120 rolls AG10, delivery to Avonmouth site by the 20th please.\n\nThanks!' },
    X2_neg: {
      text: 'Vielen Dank, aber wir haben einen Rahmenvertrag mit einem anderen Lieferanten bis 2028. Bitte keine weiteren E-Mails.\n\nThomas Richter',
      en: 'Thank you, but we have a framework agreement with another supplier until 2028. Please no further emails.\n\nThomas Richter',
    },
    X3_bounce: { text: "Delivery to the following recipient failed permanently:\n\n    marek.dabrowski@izolbud-slask.example.pl\n\nTechnical details of permanent failure:\n550 5.1.1 The email account that you tried to reach does not exist." },
    X4_unsub: {
      text: 'Per favore rimuovete il nostro indirizzo dalla vostra mailing list. Grazie.',
      en: 'Please remove our address from your mailing list. Thank you.',
    },
  } satisfies Record<string, Text>;

  // ---- outbound staged replies ----
  const OUT = {
    P3_pitch: {
      text: 'Guten Tag Herr Becker,\n\nanbei die gewünschten Unterlagen: Datenblatt AG10 und Leistungserklärung (DoP). Für eine Kälteleitung DN150 reichen typischerweise 2 × 10 mm statt 80 mm PIR – ich rechne Ihnen das gern für Ihre Medientemperatur durch.\n\nMit freundlichen Grüßen\nJordan Avery',
      en: 'Hello Mr Becker,\n\nplease find the requested documents: AG10 datasheet and declaration of performance (DoP). For a DN150 cold line, 2 × 10 mm typically replaces 80 mm of PIR — happy to run the numbers for your media temperature.\n\nKind regards,\nJordan Avery',
    },
    I1_eng: { text: "Hi Laura,\n\nGreat — I'll send a 1.5 m sample roll of AG10 to your Wilton office this week, plus the Teesside case study.\n\nBest,\nMarta" },
    I2_eng: {
      text: 'Buongiorno Luca,\n\nsì: la configurazione EN 1366-3 copre tubi in PVC fino a 110 mm con EI 120 in parete in cartongesso e solaio. Le invio l’estratto del rapporto di prova.\n\nCordiali saluti,\nJordan Avery',
      en: 'Good morning Luca,\n\nyes: the EN 1366-3 configuration covers PVC pipes up to 110 mm at EI 120 in plasterboard walls and floors. I am sending you the test report extract.\n\nKind regards,\nJordan Avery',
    },
    Q1_eng: { text: 'Hi Fiona,\n\nGreat — how about Thursday 10:00 on Teams? I will bring a thickness comparison for your line sizes.\n\nMarta' },
    Q1_pitch: { text: 'Hi Fiona,\n\nThanks for the call. As discussed: for the 200 mm steam main at 180 °C, 30 mm AG10 matches the heat loss of 100 mm mineral wool and fits the pipe bridge without re-spacing. Indicative pricing attached in the follow-up from our sales desk.\n\nMarta' },
    Q2_eng: {
      text: 'Dzień dobry Panie Krzysztofie,\n\npróbki płyt 110 kg/m³ wyślemy kurierem jutro. Cennik dla 4 000 m² prześlę do końca tygodnia.\n\nPozdrawiam,\nMarta Zielonka',
    },
    Q3_eng: {
      text: 'Hallo Frau Hoffmann,\n\ngerne – anbei die Übersicht der Prüfkonfigurationen nach EN 1366-3. Muster schicken wir nach Fechenheim. Passt Ihnen ein kurzer Termin nächste Woche?\n\nViele Grüße\nJordan Avery',
      en: 'Hello Ms Hoffmann,\n\ncertainly — attached is the overview of the EN 1366-3 test configurations. We will send samples to Fechenheim. Would a short meeting next week suit you?\n\nBest regards,\nJordan Avery',
    },
    H1_eng: { text: 'Hi Daniel,\n\nAbsolutely — our UK field engineer Ben can visit. Which dates work for the site induction?\n\nMarta' },
    H1_pitch: { text: 'Hi Daniel,\n\nAttached thickness comparison for the BOG lines: 20 mm AG10 vs 75 mm cellular glass, with install-time estimates. Ben will bring samples on the 14th.\n\nMarta' },
    H2_eng: { text: 'Dzień dobry,\n\ndziękuję — przekazuję temat do naszego kierownika regionu, który skontaktuje się z działem zakupów w przyszłym tygodniu.\n\nPozdrawiam,\nMarta Zielonka' },
    S1_pitch: { text: 'Hi Ian,\n\nPlease find our quote for 2,000 m² AG10 (10 mm), delivered Aberdeen, 3-week lead time. Happy to walk through it.\n\nMarta' },
    X1_pitch: { text: 'Hi Tom,\n\nPricing for AG10 10 mm attached — 120 rolls covers the Avonmouth scope with 8% waste.\n\nMarta' },
    X1_close: { text: 'Hi Tom,\n\nThank you for the order — confirmed for delivery to Avonmouth by the 20th. I will send tracking details once dispatched.\n\nMarta' },
  } satisfies Record<string, Text>;

  const ev = (t: ThreadEvent['t'], at: Date, extra: Partial<ThreadEvent> = {}): ThreadEvent => ({ t, at, ...extra });
  const pendingFU = (base: number): FollowUpPlanRow[] => [
    { step: 1, status: 'pending', scheduledFor: ago(base - 4) },
    { step: 2, status: 'pending', scheduledFor: ago(base - 10) },
    { step: 3, status: 'pending', scheduledFor: ago(base - 18) },
  ];

  async function seedExternalMail(): Promise<void> {
    const extThread1 = await insertThread(A, MB1.id, 'Exhibitor pack — Insulation Expo 2026 (Birmingham NEC)', ['events@insulation-expo.example.co.uk', MB1.fromAddress], ago(6, 3));
    await insertMsg({
      workspaceId: A,
      mailboxId: MB1.id,
      threadId: extThread1,
      direction: 'inbound',
      status: 'received',
      messageId: newMessageId(),
      fromAddress: 'events@insulation-expo.example.co.uk',
      fromName: 'Insulation Expo 2026',
      toAddresses: [MB1.fromAddress],
      subject: 'Exhibitor pack — Insulation Expo 2026 (Birmingham NEC)',
      bodyText: 'Dear exhibitor,\n\nThank you for booking stand C14. Your exhibitor pack, stand plan and build-up times are attached. Deadline for catalogue entries is 15 October.\n\nKind regards,\nExhibitor Services',
      attachments: [{ filename: 'Exhibitor-pack-2026.pdf', contentType: 'application/pdf', sizeBytes: 1_284_533 }],
      receivedAt: ago(6, 3),
      contactId: expoContact.id,
      replyClassification: 'irrelevant',
      replyClassificationConfidence: 40,
      replyClassifiedAt: ago(6, 3),
      createdAt: ago(6, 3),
      updatedAt: ago(6, 3),
    });
    const spamThread = await insertThread(A, MB1.id, '10,000 verified B2B leads for €99 — today only', ['promo@cheap-leads.example.net', MB1.fromAddress], ago(3, 9));
    await insertMsg({
      workspaceId: A,
      mailboxId: MB1.id,
      threadId: spamThread,
      direction: 'inbound',
      status: 'received',
      messageId: newMessageId(),
      fromAddress: 'promo@cheap-leads.example.net',
      fromName: 'Lead Deals',
      toAddresses: [MB1.fromAddress],
      subject: '10,000 verified B2B leads for €99 — today only',
      bodyText: 'Boost your pipeline with 10,000 verified decision-maker emails. Reply YES to receive the list.',
      receivedAt: ago(3, 9),
      replyClassification: 'irrelevant',
      replyClassificationConfidence: 30,
      replyClassifiedAt: ago(3, 9),
      spamAt: ago(3, 8),
      spamReason: 'manual',
      createdAt: ago(3, 9),
      updatedAt: ago(3, 8),
    });
    const trashThread = await insertThread(A, MB2.id, 'Automatic reply: Rohrleitungsisolierung', ['info@hansa-daemmtechnik.example.de', MB2.fromAddress], ago(15, 1));
    await insertMsg({
      workspaceId: A,
      mailboxId: MB2.id,
      threadId: trashThread,
      direction: 'inbound',
      status: 'received',
      messageId: newMessageId(),
      fromAddress: 'info@hansa-daemmtechnik.example.de',
      fromName: 'Hansa Dämmtechnik',
      toAddresses: [MB2.fromAddress],
      subject: 'Automatic reply: Rohrleitungsisolierung',
      bodyText: 'Vielen Dank für Ihre Nachricht. Wir bearbeiten Ihre Anfrage so schnell wie möglich.',
      bodyTextNative: 'Thank you for your message. We will process your request as soon as possible.',
      nativeLanguage: 'en',
      translatedFromLanguage: 'de',
      receivedAt: ago(15, 1),
      replyClassification: 'out_of_office',
      replyClassificationConfidence: 70,
      replyClassifiedAt: ago(15, 1),
      trashedAt: ago(10),
      createdAt: ago(15, 1),
      updatedAt: ago(10),
    });
    const testThread = await insertThread(A, MB2.id, 'Test email from Lead Discovery', [MB2.fromAddress], ago(29, 2));
    await insertMsg({
      workspaceId: A,
      mailboxId: MB2.id,
      threadId: testThread,
      direction: 'outbound',
      status: 'delivered',
      messageId: newMessageId(),
      fromAddress: MB2.fromAddress,
      fromName: MB2.fromName,
      toAddresses: [MB2.fromAddress],
      subject: 'Test email from Lead Discovery',
      bodyText: 'This is a test email confirming SMTP settings for this mailbox.',
      sentAt: ago(29, 2),
      deliveredAt: ago(29, 2),
      createdBy: ADMIN_ID,
      createdAt: ago(29, 2),
      updatedAt: ago(29, 2),
    });
    const mb3Thread = await insertThread(A, MB3.id, 'Re: Fire stopping datasheet', ['outreach@northwind-mail.example.com', 'buyer@wessex-passivefire.example.co.uk'], ago(3, 6));
    await insertMsg({
      workspaceId: A,
      mailboxId: MB3.id,
      threadId: mb3Thread,
      direction: 'outbound',
      status: 'failed',
      messageId: newMessageId(),
      fromAddress: 'outreach@northwind-mail.example.com',
      fromName: 'Northwind Insulation',
      toAddresses: ['buyer@wessex-passivefire.example.co.uk'],
      subject: 'Re: Fire stopping datasheet',
      bodyText: 'Hello, please find the NW-FS datasheet as requested.',
      failureReason: '535 5.7.8 Authentication credentials invalid',
      createdBy: ADMIN_ID,
      createdAt: ago(3, 6),
      updatedAt: ago(3, 6),
    });
  }

  const plans: Partial<Record<LeadKey, (l: LeadInfo) => ThreadPlan[]>> = {
    C1: () => [{ contactKey: 'current', mailbox: 'MB1', events: [ev('discovery', ago(2, 5), { opens: 2 })], followUps: pendingFU(2) }],
    C2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(9, 5), { opens: 1 }), ev('followup', ago(5, 4), { step: 1 })],
        followUps: [
          { step: 1, status: 'sent', scheduledFor: ago(5, 4) },
          { step: 2, status: 'awaiting_approval', scheduledFor: ago(0, 3) },
          { step: 3, status: 'pending', scheduledFor: ahead(8) },
        ],
      },
    ],
    C3: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(8, 5), { opens: 3 })],
        followUps: [
          { step: 1, status: 'awaiting_approval', scheduledFor: ago(0, 1) },
          { step: 2, status: 'pending', scheduledFor: ahead(6) },
          { step: 3, status: 'pending', scheduledFor: ahead(14) },
        ],
      },
    ],
    C4: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(12, 5), { opens: 0 }),
          ev('in', ago(12, 4, 55), { cls: 'out_of_office', conf: 92, body: RE.C4_ooo }),
          ev('followup', ago(8, 4), { step: 1, opens: 1 }),
        ],
        followUps: [
          { step: 1, status: 'sent', scheduledFor: ago(8, 4) },
          { step: 2, status: 'pending', scheduledFor: ahead(0, 20) },
          { step: 3, status: 'pending', scheduledFor: ahead(8) },
        ],
      },
    ],
    C5: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(5, 5), { opens: 0 })],
        followUps: [
          { step: 1, status: 'failed', scheduledFor: ago(1, 5), processedAt: ago(1, 4), lastError: 'AI compose failed after 3 retries: provider timeout (openai, 60 s)' },
          { step: 2, status: 'pending', scheduledFor: ahead(5) },
          { step: 3, status: 'pending', scheduledFor: ahead(13) },
        ],
      },
    ],
    C6: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(15, 5), { opens: 1 }), ev('followup', ago(11, 4), { step: 1 }), ev('followup', ago(5, 4), { step: 2, opens: 2 })],
        followUps: [
          { step: 1, status: 'sent', scheduledFor: ago(11, 4) },
          { step: 2, status: 'sent', scheduledFor: ago(5, 4) },
          { step: 3, status: 'awaiting_approval', scheduledFor: ago(0, 6) },
        ],
      },
    ],
    P1: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(6, 5), { opens: 3 }), ev('followup', ago(2, 4), { step: 1 }), ev('in', ago(1, 2), { cls: 'positive', conf: 88, body: RE.P1_pos })],
        followUps: skippedFU(6, ago(1, 2), [1]),
      },
    ],
    P2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(11, 5)), ev('followup', ago(7, 4), { step: 1 }), ev('in', ago(2, 2), { cls: 'question', conf: 85, body: RE.P2_q })],
        followUps: skippedFU(11, ago(2, 2), [1]),
      },
    ],
    P3: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(10, 5), { opens: 2 }), ev('followup', ago(6, 4), { step: 1 }), ev('in', ago(3, 2), { cls: 'doc_request', conf: 90, body: RE.P3_doc }), ev('out', ago(2, 6), { stage: 'pitch', body: OUT.P3_pitch })],
        followUps: skippedFU(10, ago(3, 2), [1]),
      },
    ],
    P4: (l) => [
      {
        contactKey: 'original',
        mailbox: 'MB1',
        events: [ev('discovery', ago(13, 5), { opens: 1 }), ev('followup', ago(9, 4), { step: 1 }), ev('in', ago(4, 2), { cls: 'redirect', conf: 86, body: RE.P4_redirect, extracted: [l.contact.email] })],
        followUps: skippedFU(13, ago(4, 2), [1]),
        closed: { at: ago(4, 1), reason: 'handed_off', referralTo: l.contact.email },
      },
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(3, 5), { opens: 1 })],
        followUps: pendingFU(3),
        referralChain: [{ from_email: must(l.originalContact, 'orig').email, from_name: must(l.originalContact, 'orig').name, at: ago(4, 2).toISOString() }],
      },
    ],
    I1: (l) => [
      {
        contactKey: 'original',
        mailbox: 'MB1',
        events: [ev('discovery', ago(21, 5)), ev('in', ago(17, 2), { cls: 'redirect', conf: 84, body: RE.I1_redirect, extracted: [l.contact.email] })],
        followUps: skippedFU(21, ago(17, 2)),
        closed: { at: ago(17, 1), reason: 'handed_off', referralTo: l.contact.email },
      },
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(16, 5), { opens: 2 }), ev('in', ago(14, 2), { cls: 'interest', conf: 80, body: RE.I1_interest }), ev('out', ago(13, 6), { stage: 'engagement', body: OUT.I1_eng })],
        followUps: skippedFU(16, ago(14, 2)),
        referralChain: [{ from_email: must(l.originalContact, 'orig').email, from_name: must(l.originalContact, 'orig').name, at: ago(17, 2).toISOString() }],
      },
    ],
    I2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(12, 5), { opens: 1 }), ev('in', ago(8, 2), { cls: 'interest', conf: 78, body: RE.I2_interest }), ev('out', ago(7, 6), { stage: 'engagement', body: OUT.I2_eng })],
        followUps: skippedFU(12, ago(8, 2)),
      },
    ],
    Q1: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(22, 5), { opens: 2 }),
          ev('in', ago(19, 4), { cls: 'positive', conf: 91, body: RE.Q1_pos1 }),
          ev('out', ago(19, 2), { stage: 'engagement', body: OUT.Q1_eng }),
          ev('in', ago(18, 6), { cls: 'positive', conf: 84, body: RE.Q1_pos2 }),
          ev('out', ago(9, 3), { stage: 'pitch', body: OUT.Q1_pitch }),
        ],
        followUps: skippedFU(22, ago(19, 4)),
      },
    ],
    Q2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(20, 5)), ev('followup', ago(16, 4), { step: 1 }), ev('in', ago(15, 2), { cls: 'positive', conf: 87, body: RE.Q2_pos }), ev('out', ago(14, 6), { stage: 'engagement', body: OUT.Q2_eng })],
        followUps: skippedFU(20, ago(15, 2), [1]),
      },
    ],
    Q3: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(17, 5), { opens: 4 }), ev('in', ago(12, 2), { cls: 'positive', conf: 85, body: RE.Q3_pos }), ev('out', ago(11, 6), { stage: 'engagement', body: OUT.Q3_eng })],
        followUps: skippedFU(17, ago(12, 2)),
      },
    ],
    H1: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(24, 5), { opens: 3 }),
          ev('in', ago(21, 4), { cls: 'positive', conf: 90, body: RE.H1_pos1 }),
          ev('out', ago(21, 2), { stage: 'engagement', body: OUT.H1_eng }),
          ev('out', ago(14, 3), { stage: 'pitch', body: OUT.H1_pitch }),
          ev('in', ago(13, 2), { cls: 'positive', conf: 83, body: RE.H1_pos2 }),
        ],
        followUps: skippedFU(24, ago(21, 4)),
      },
    ],
    H2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [ev('discovery', ago(21, 5)), ev('in', ago(18, 2), { cls: 'positive', conf: 86, body: RE.H2_pos }), ev('out', ago(17, 6), { stage: 'engagement', body: OUT.H2_eng })],
        followUps: skippedFU(21, ago(18, 2)),
      },
    ],
    S1: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(25, 5), { opens: 2 }),
          ev('in', ago(22, 2), { cls: 'positive', conf: 89, body: RE.S1_pos1 }),
          ev('out', ago(21, 6), { stage: 'pitch', body: OUT.S1_pitch }),
          ev('in', ago(16, 2), { cls: 'positive', conf: 92, body: RE.S1_pos2 }),
        ],
        followUps: skippedFU(25, ago(22, 2)),
      },
    ],
    X1: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(25, 6), { opens: 1 }),
          ev('in', ago(23, 2), { cls: 'positive', conf: 88, body: RE.X1_pos1 }),
          ev('out', ago(22, 6), { stage: 'pitch', body: OUT.X1_pitch }),
          ev('in', ago(15, 2), { cls: 'positive', conf: 90, body: RE.X1_pos2, attachments: [{ filename: 'PO-4471.pdf', contentType: 'application/pdf', sizeBytes: 84211 }] }),
          ev('out', ago(14, 6), { stage: 'closing', body: OUT.X1_close }),
        ],
        followUps: skippedFU(25, ago(23, 2)),
      },
    ],
    X2: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(16, 5), { opens: 1 }), ev('in', ago(14, 2), { cls: 'negative', conf: 88, body: RE.X2_neg })],
        followUps: skippedFU(16, ago(14, 2)),
        closed: { at: ago(14, 1), reason: 'decline' },
      },
    ],
    X3: () => [
      {
        contactKey: 'current',
        mailbox: 'MB1',
        events: [
          ev('discovery', ago(19, 5), { bounced: '550 5.1.1 The email account that you tried to reach does not exist' }),
          ev('in', ago(19, 4, 58), { cls: 'bounce', conf: 97, body: RE.X3_bounce, fromAddress: 'mailer-daemon@mx.izolbud-slask.example.pl', fromName: 'Mail Delivery Subsystem' }),
        ],
        followUps: [1, 2, 3].map((step) => ({ step, status: 'skipped' as const, scheduledFor: ago(19 - [4, 10, 18][step - 1]!), processedAt: ago(19, 4), skipReason: 'bounce' })),
        closed: { at: ago(19, 4), reason: 'bounce' },
      },
    ],
    X4: () => [
      {
        contactKey: 'current',
        mailbox: 'MB2',
        events: [ev('discovery', ago(13, 5)), ev('in', ago(11, 2), { cls: 'unsubscribe', conf: 95, body: RE.X4_unsub })],
        followUps: skippedFU(13, ago(11, 2)),
        closed: { at: ago(11, 1), reason: 'unsubscribe' },
      },
    ],
  };

  // External (non-outreach) mail first, so lead replies end up with the
  // highest ids — the dashboard's "recent inbound" orders by id desc.
  await seedExternalMail();

  // Build threads oldest-activity first for the same reason.
  const toBuild: [LeadInfo, ThreadPlan][] = [];
  for (const [key, mk] of Object.entries(plans) as [LeadKey, (l: LeadInfo) => ThreadPlan[]][]) {
    const lead = L(key);
    for (const tp of mk(lead)) toBuild.push([lead, tp]);
  }
  const lastEventAt = (tp: ThreadPlan): number => Math.max(...tp.events.map((e) => e.at.getTime()));
  toBuild.sort((a, b) => lastEventAt(a[1]) - lastEventAt(b[1]));
  for (const [lead, tp] of toBuild) {
    const contact = tp.contactKey === 'original' ? must(lead.originalContact, 'original contact') : lead.contact;
    await buildThread(lead, tp, contact);
  }

  // Referral handoff pointers (closed thread state → new thread state)
  for (const key of ['P4', 'I1'] as const) {
    const ths = must(leadThreads.get(key), 'threads');
    const oldTs = threadStateIds.get(must(ths[0], 'old').threadId);
    const newTs = threadStateIds.get(must(ths[1], 'new').threadId);
    if (oldTs && newTs) {
      await db.update(s.outreachThreadState).set({ referralToThreadStateId: newTs }).where(eqId(s.outreachThreadState.id, oldTs));
    }
  }

  // Leads without threads: drafts only (+ queue rows)
  const R = (k: LeadKey) => L(k);
  const mkDiscovery = (l: LeadInfo, mb: typeof MB1) => discoveryText(l.product, l.lang, l.contact.first, l.sd.co.name, senderOf(mb));
  // R1: an older superseded version + a fresh pending draft
  await insertDraft(R('R1'), { stage: 'discovery', ...mkDiscovery(R('R1'), MB1), at: ago(6, 3), confidence: 61 });
  await insertDraft(R('R1'), { stage: 'discovery', ...mkDiscovery(R('R1'), MB1), at: ago(1, 2), confidence: 84 });
  await insertDraft(R('R2'), { stage: 'discovery', ...mkDiscovery(R('R2'), MB1), at: ago(2, 4) });
  await insertDraft(R('R3'), { stage: 'discovery', ...mkDiscovery(R('R3'), MB2), at: ago(3, 6), confidence: 58 });
  for (const k of ['R4', 'R5', 'R6', 'R7'] as const) {
    await insertDraft(R(k), { stage: 'discovery', ...mkDiscovery(R(k), k === 'R5' ? MB2 : MB1), at: ago(LEAD_PLANS[k].relevantAgo - 1, 3) });
  }
  // P1 / P2: engagement drafts awaiting review (triggered by the inbound reply)
  const lastInboundOf = async (k: LeadKey): Promise<bigint | null> => {
    const ths = leadThreads.get(k);
    const last = ths?.[ths.length - 1];
    if (!last) return null;
    const rows = await db
      .select({ id: s.mailMessages.id })
      .from(s.mailMessages)
      .where(and(eq(s.mailMessages.threadId, last.threadId), eq(s.mailMessages.direction, 'inbound')))
      .orderBy(desc(s.mailMessages.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  };
  await insertDraft(L('P1'), {
    stage: 'engagement',
    subject: { text: `Re: ${mkDiscovery(L('P1'), MB1).subject.text}` },
    body: { text: "Hi Sarah,\n\nGreat to hear. AG10 datasheet attached; for 150 mm cold lines 10 mm usually does the job of 50 mm PIR. Indicative price for ~400 m is in the range of £38–42/m installed-material, depending on fittings.\n\nWould a 15-minute call on Thursday help to confirm the line temperatures?\n\nBest,\nMarta" },
    at: ago(0, 20),
    triggeredBy: await lastInboundOf('P1'),
    confidence: 81,
  });
  await insertDraft(L('P2'), {
    stage: 'engagement',
    subject: { text: `Re: ${mkDiscovery(L('P2'), MB1).subject.text}` },
    body: { text: 'Dzień dobry Pani Agnieszko,\n\nminimalne zamówienie to jedna paleta (ok. 86 m² dla 100 mm). Płyty 90 kg/m³ mają klasyfikację EI 120 w systemie z blachą trapezową — prześlę raport klasyfikacyjny.\n\nPozdrawiam,\nMarta Zielonka' },
    at: ago(1, 20),
    triggeredBy: await lastInboundOf('P2'),
    confidence: 66,
  });
  // X2: closing reply drafted but rejected by the operator
  await insertDraft(L('X2'), {
    stage: 'closing',
    subject: { text: 'Re: Rohrleitungsisolierung bei Hansa Dämmtechnik', en: 'Re: Pipe insulation specs at Hansa Dämmtechnik' },
    body: { text: 'Vielen Dank für Ihre Rückmeldung, Herr Richter. Wir melden uns gerne 2028 noch einmal.\n\nJordan Avery', en: 'Thank you for your reply, Mr Richter. We would be happy to get back in touch in 2028.\n\nJordan Avery' },
    at: ago(13, 20),
    triggeredBy: await lastInboundOf('X2'),
  });

  // Finalise draft statuses: last draft per lead is the active one.
  const finalStatus: Partial<Record<LeadKey, s.OutreachDraftStatus>> = {
    R1: 'draft',
    R2: 'draft',
    R3: 'needs_edit',
    P1: 'draft',
    P2: 'needs_edit',
    X2: 'rejected',
  };
  const activeDraft = new Map<LeadKey, bigint>();
  for (const [key, ids] of draftsByLead) {
    const last = must(ids[ids.length - 1], 'last draft');
    activeDraft.set(key, last);
    const status = finalStatus[key] ?? 'approved';
    const lead = L(key);
    const actor = lead.plan.assignee === 'admin' ? ADMIN_ID : MEMBER_ID;
    const rows = await db.select({ createdAt: s.outreachDrafts.createdAt }).from(s.outreachDrafts).where(eqId(s.outreachDrafts.id, last));
    const createdAt = must(rows[0], 'draft row').createdAt;
    await db
      .update(s.outreachDrafts)
      .set({
        status,
        approvedByUserId: status === 'approved' ? actor : null,
        approvedAt: status === 'approved' ? plus(createdAt, between(10, 120) * MIN) : null,
        rejectedByUserId: status === 'rejected' ? actor : null,
        rejectedAt: status === 'rejected' ? plus(createdAt, 2 * HOUR) : null,
        rejectionReason: status === 'rejected' ? 'They asked for no further emails — do not reply.' : null,
        editedByUserId: status === 'needs_edit' ? MEMBER_ID : null,
        editedAt: status === 'needs_edit' ? plus(createdAt, 3 * HOUR) : null,
      })
      .where(eqId(s.outreachDrafts.id, last));
    // earlier drafts in the chain were approved (and sent) before being superseded
    if (ids.length > 1) {
      await db
        .update(s.outreachDrafts)
        .set({ approvedByUserId: actor })
        .where(inArray(s.outreachDrafts.id, ids.slice(0, -1)));
    }
  }
  await client`update outreach_drafts set approved_at = created_at + interval '35 minutes' where status = 'superseded' and approved_by_user_id is not null`;

  // Rejected drafts on rejected review items (generated before review)
  for (const name of ['Home Loft Insulation Direct', 'PPHU Ociepl-Dom', 'Ostsee LNG Terminal Services GmbH']) {
    const sd = must(seeded.find((x) => x.co.name === name), name);
    const pk = sd.primary;
    const isMismatch = sd.co.outcome === 'mismatch';
    const d = discoveryText(pk, isMismatch ? 'en' : LANG_OF[must(sd.co.country, 'c')], 'there', sd.co.name, 'Marta Zielonka\nNorthwind Insulation');
    await db.insert(s.outreachDrafts).values({
      workspaceId: A,
      reviewItemId: sd.reviewItemId,
      sourceRecordId: sd.sourceRecordId,
      productProfileId: P[pk],
      qualificationId: sd.qualIds.get(pk) ?? null,
      status: 'rejected',
      stage: 'discovery',
      channel: 'email',
      language: pk === 'wool' ? 'pl' : 'en',
      subject: d.subject.en ?? d.subject.text,
      body: d.body.en ?? d.body.text,
      confidence: between(35, 55),
      method: 'ai',
      model: 'gpt-5-mini',
      evidence: { stage: 'discovery', productSnapshot: { name: PRODUCT_LABEL[pk] } },
      rejectionReason: isMismatch
        ? 'Geo gate: company is in Germany, recipe targets the UK.'
        : 'Residential installer — not a target customer. Lesson recorded.',
      rejectedByUserId: MEMBER_ID,
      rejectedAt: plus(sd.createdAt, 30 * HOUR),
      createdAt: plus(sd.createdAt, 2 * HOUR),
      updatedAt: plus(sd.createdAt, 30 * HOUR),
    });
  }

  // Queue: pending / failed / skipped / cancelled for the R-leads + one scheduled reply
  const qBase = (k: LeadKey, mb: typeof MB1) => {
    const l = L(k);
    const d = mkDiscovery(l, mb);
    return {
      workspaceId: A,
      mailboxId: mb.id,
      draftId: must(activeDraft.get(k), `draft ${k}`),
      toAddresses: [l.contact.email],
      subject: d.subject.text,
      bodyText: d.body.text,
      createdBy: MEMBER_ID,
    };
  };
  queueRows.push(
    { ...qBase('R4', MB1), status: 'queued', delayMode: 'random', scheduledSendAt: ahead(0, 0, 45), createdAt: ago(0, 2), updatedAt: ago(0, 2) },
    { ...qBase('R5', MB2), status: 'queued', delayMode: 'fixed', scheduledSendAt: ahead(1, 3), lastError: 'Outside business hours for mailbox (Europe/Berlin 09–18) — moved to next window', createdAt: ago(0, 5), updatedAt: ago(0, 5) },
    { ...qBase('R6', MB1), status: 'failed', delayMode: 'random', scheduledSendAt: ago(1, 6), attemptCount: 3, lastError: 'SMTP 421 4.7.0 Temporary server error. Please try again later (gave up after 3 attempts)', createdAt: ago(1, 8), updatedAt: ago(1, 2) },
    { ...qBase('R7', MB1), status: 'skipped', delayMode: 'random', scheduledSendAt: ago(3, 2), attemptCount: 0, lastError: 'Domain cooldown: lse-elewacje.example.pl was emailed < 48 h ago', createdAt: ago(3, 4), updatedAt: ago(3, 2) },
    {
      workspaceId: A,
      mailboxId: MB1.id,
      draftId: null,
      toAddresses: ['hannah.price@anglia-pipework.example.co.uk'],
      subject: 'Samples for your cold store project',
      bodyText: 'Hi Hannah, following our call — sample roll on its way. Marta',
      status: 'cancelled',
      delayMode: 'immediate',
      scheduledSendAt: ago(4, 1),
      lastError: 'Cancelled by operator',
      createdBy: MEMBER_ID,
      createdAt: ago(4, 2),
      updatedAt: ago(4, 1),
    },
  );
  // Scheduled in-thread reply (shows as "scheduled" on /communication)
  {
    const q3 = L('Q3');
    const ths = must(leadThreads.get('Q3'), 'Q3 threads');
    const last = must(ths[ths.length - 1], 'Q3 thread');
    const lastIn = await db
      .select({ message_id: s.mailMessages.messageId })
      .from(s.mailMessages)
      .where(eq(s.mailMessages.threadId, last.threadId))
      .orderBy(desc(s.mailMessages.createdAt))
      .limit(1);
    queueRows.push({
      workspaceId: A,
      mailboxId: MB2.id,
      draftId: null,
      toAddresses: [q3.contact.email],
      subject: 'Re: Abschottungen bei Projekten von Rechenzentrum Ausbau Frankfurt',
      bodyText: 'Hallo Frau Hoffmann, kurze Erinnerung an unseren Termin am Dienstag um 10:00. Viele Grüße, Jordan Avery',
      inReplyTo: lastIn[0]?.message_id ?? null,
      status: 'queued',
      delayMode: 'fixed',
      scheduledSendAt: ahead(1, 1),
      createdBy: ADMIN_ID,
      createdAt: ago(0, 4),
      updatedAt: ago(0, 4),
    });
  }
  await db.insert(s.outreachQueue).values(queueRows);
  if (emailOpenRows.length > 0) await db.insert(s.emailOpens).values(emailOpenRows);

  // link follow-up rows to their queue entries / messages
  await db.insert(s.outreachFollowUps).values(followUpRows);
  await client`
    update outreach_follow_ups f
       set queue_entry_id = q.id
      from outreach_queue q
     where f.sent_message_id is not null and q.sent_message_id = f.sent_message_id`;

  // Failed send for R6 (errors folder) + external / spam / trash mail
  const r6 = L('R6');
  const r6Draft = mkDiscovery(r6, MB1);
  const r6Thread = await insertThread(A, MB1.id, r6Draft.subject.text, [MB1.fromAddress, r6.contact.email], ago(1, 2));
  const r6Msg = await insertMsg({
    workspaceId: A,
    mailboxId: MB1.id,
    threadId: r6Thread,
    direction: 'outbound',
    status: 'failed',
    messageId: newMessageId(),
    fromAddress: MB1.fromAddress,
    fromName: MB1.fromName,
    toAddresses: [r6.contact.email],
    subject: r6Draft.subject.text,
    bodyText: r6Draft.body.text,
    failureReason: 'SMTP 421 4.7.0 Temporary server error. Please try again later',
    sourceDraftId: activeDraft.get('R6') ?? null,
    contactId: r6.contact.id,
    createdBy: MEMBER_ID,
    createdAt: ago(1, 2),
    updatedAt: ago(1, 2),
  });
  void r6Msg;

  // current thread pointer on leads
  for (const [key, ths] of leadThreads) {
    const last = must(ths[ths.length - 1], 'thread');
    await db.update(s.qualifiedLeads).set({ currentThreadId: last.threadId }).where(eqId(s.qualifiedLeads.id, L(key).id));
  }

  await db.insert(s.contactAssociations).values(associations).onConflictDoNothing();

  // ======================= pipeline events =======================
  const order: s.PipelineState[] = ['relevant', 'contacted', 'replied', 'contact_identified', 'qualified', 'handed_over', 'synced_to_crm', 'closed'];
  const evRows: s.NewPipelineEvent[] = [];
  for (const lead of leads.values()) {
    const p = lead.plan;
    const actor = userFor(p.assignee) ?? MEMBER_ID;
    const stamps: Partial<Record<s.PipelineState, number | undefined>> = {
      relevant: p.relevantAgo,
      contacted: p.contactedAgo,
      replied: p.repliedAgo,
      contact_identified: p.identifiedAgo,
      qualified: p.qualifiedAgo,
      handed_over: p.handedAgo,
      synced_to_crm: p.syncedAgo,
      closed: p.closedAgo,
    };
    let prev: s.PipelineState | null = null;
    for (const st of order) {
      const d = stamps[st];
      if (d === undefined) continue;
      evRows.push({
        workspaceId: A,
        qualifiedLeadId: lead.id,
        fromState: prev,
        toState: st,
        eventKind: prev === null ? 'creation' : 'transition',
        payload:
          st === 'closed'
            ? { closeReason: p.closeReason, note: p.closeNote }
            : st === 'contacted'
              ? { via: 'outreach_queue' }
              : st === 'replied'
                ? { via: 'reply_classifier' }
                : {},
        actorUserId: st === 'contacted' || st === 'replied' ? null : actor,
        createdAt: ago(d, 1),
      });
      prev = st;
    }
    if (p.assignee) {
      evRows.push({ workspaceId: A, qualifiedLeadId: lead.id, fromState: prev, toState: must(prev, 'state'), eventKind: 'assignment', payload: { assignedTo: userFor(p.assignee) }, actorUserId: ADMIN_ID, createdAt: ago(p.relevantAgo, 0, 50) });
    }
    if (p.notes) {
      evRows.push({ workspaceId: A, qualifiedLeadId: lead.id, fromState: prev, toState: must(prev, 'state'), eventKind: 'note', payload: { note: p.notes }, actorUserId: actor, createdAt: ago(Math.max(0, (p.qualifiedAgo ?? 1) - 1), 3) });
    }
    if (lead.originalContact) {
      evRows.push({ workspaceId: A, qualifiedLeadId: lead.id, fromState: prev, toState: must(prev, 'state'), eventKind: 'contact_update', payload: { from: lead.originalContact.email, to: lead.contact.email, reason: 'referral' }, actorUserId: null, createdAt: ago(p.repliedAgo ?? 1, 1) });
    }
  }
  await db.insert(s.pipelineEvents).values(evRows);

  // ======================= lead research =======================
  const researchFor = (k: LeadKey, question: string, answer: string, at: Date, cites: [string, string, string][]) => ({
    workspaceId: A,
    qualifiedLeadId: L(k).id,
    question,
    questionHash: hex(64),
    answer,
    citations: cites.map(([url, title, snippet], i) => ({ rank: i + 1, url, domain: new URL(url).hostname, title, snippet })),
    queriesIssued: [question.slice(0, 60), `${L(k).sd.co.name} projects 2026`],
    providerId: 'gemini',
    costEstimateCents: between(2, 6),
    createdBy: MEMBER_ID,
    createdAt: at,
  });
  await db.insert(s.leadResearch).values([
    researchFor(
      'Q1',
      'What does Clydeside Thermal Engineering do, and what recent projects matter for an insulation supplier?',
      '**Clydeside Thermal Engineering** is a Glasgow-based insulation contractor serving distilleries and district heating.\n\n- Won a steam-main replacement at a Speyside distillery (2026).\n- Uses mineral wool and cellular glass today; space constraints on pipe bridges are a recurring issue.\n- Approx. 60 staff, NICEIC-registered.',
      ago(20, 2),
      [
        ['https://clydeside-thermal.example.co.uk/projects/speyside', 'Speyside steam main — project page', 'Replacement of 2 km steam main on a congested pipe bridge…'],
        ['https://news.example.co.uk/scotland/distillery-upgrade', 'Distillery invests in energy upgrade', 'The distillery will replace its ageing steam distribution…'],
      ],
    ),
    researchFor(
      'H1',
      'What does Kent LNG Terminal Services do and who runs their maintenance programmes?',
      '**Kent LNG Terminal Services** maintains cryogenic lines at an LNG import terminal.\n\n- Annual CUI inspection campaign on boil-off gas (BOG) lines.\n- Maintenance engineering lead: Daniel Okafor.\n- Prefers suppliers with on-site technical support.',
      ago(22, 4),
      [
        ['https://kent-lng-services.example.co.uk/about', 'About us', 'Maintenance and insulation services for LNG terminal cryogenic lines…'],
        ['https://energy-journal.example.com/lng-terminal-cui', 'Tackling CUI on LNG terminals', 'Operators are moving to hydrophobic insulation systems…'],
        ['https://kent-lng-services.example.co.uk/careers', 'Careers', 'We are hiring insulation supervisors for the 2026 campaign…'],
      ],
    ),
    researchFor(
      'P1',
      'What does Humber Process Insulation do ({domain}) and what recent news matters?',
      'Humber Process Insulation works on refineries and biofuel plants on the Humber estuary. Recent: framework renewal with a Saltend chemicals park operator; looking at thinner systems for cold lines.',
      ago(1, 1),
      [['https://humber-process.example.co.uk/news/framework-2026', 'Framework renewed for 2026–2029', 'We are pleased to announce the renewal of our insulation framework…']],
    ),
    researchFor(
      'S1',
      'Grampian Energy Maintenance — supplier onboarding requirements?',
      'Grampian Energy Maintenance requires suppliers to register on their vendor portal (Achilles-style prequalification) and provide ISO 9001 certificates.',
      ago(16, 1),
      [['https://grampian-energy.example.co.uk/suppliers', 'Supplier information', 'All new suppliers must complete prequalification via our vendor portal…']],
    ),
  ]);

  // ======================= suppression =======================
  await db.insert(s.suppressionList).values([
    { workspaceId: A, kind: 'email', address: 'marek.dabrowski@izolbud-slask.example.pl', value: 'marek.dabrowski@izolbud-slask.example.pl', reason: 'bounce_hard', source: 'smtp', note: 'Auto: 550 5.1.1 user unknown', createdBy: null, createdAt: ago(19, 4) },
    { workspaceId: A, kind: 'email', address: 'alessandro.greco@termoimpianti-sud.example.it', value: 'alessandro.greco@termoimpianti-sud.example.it', reason: 'unsubscribe', source: 'reply', note: 'Auto: unsubscribe reply', createdBy: null, createdAt: ago(11, 1) },
    { workspaceId: A, kind: 'email', address: 'thomas.richter@hansa-daemmtechnik.example.de', value: 'thomas.richter@hansa-daemmtechnik.example.de', reason: 'manual', source: 'manual', note: 'Asked for no further emails (framework until 2028)', createdBy: ADMIN_ID, createdAt: ago(14) },
    { workspaceId: A, kind: 'domain', address: 'competitor-insulation.example.com', value: 'competitor-insulation.example.com', reason: 'manual', source: 'manual', note: 'Competitor — never contact', createdBy: ADMIN_ID, createdAt: ago(30) },
    { workspaceId: A, kind: 'company', address: 'leeds city council', value: 'leeds city council', reason: 'manual', source: 'manual', note: 'Public body — reach via contractors only', createdBy: MEMBER_ID, createdAt: ago(18) },
    { workspaceId: A, kind: 'email', address: 'noreply@tenders.example.co.uk', value: 'noreply@tenders.example.co.uk', reason: 'complaint', source: 'manual', note: 'Feed sender, not a person', createdBy: MEMBER_ID, createdAt: ago(17) },
    { workspaceId: A, kind: 'email', address: 'buyer@wessex-passivefire.example.co.uk', value: 'buyer@wessex-passivefire.example.co.uk', reason: 'bounce_soft', source: 'smtp', note: 'Mailbox full — retry after expiry', expiresAt: ahead(4), createdBy: null, createdAt: ago(3, 6) },
    // F-03: a pre-provenance automatic entry an admin revoked (kept as history).
    { workspaceId: A, kind: 'email', address: 'newsletter@insulation-weekly.example.com', value: 'newsletter@insulation-weekly.example.com', reason: 'unsubscribe', source: 'legacy_auto', note: 'Auto-suppressed by the reply classifier (pre-provenance)', createdBy: null, createdAt: ago(24), revokedAt: ago(2), revokedBy: ADMIN_ID, revokeReason: 'Newsletter footer matched "unsubscribe" — not an opt-out' },
  ]);

  // ======================= CRM =======================
  const crmRows = await db
    .insert(s.crmConnections)
    .values([
      { workspaceId: A, system: 'hubspot', name: 'HubSpot (sales portal)', credentialSecretKey: 'crm.hubspot_main', config: { baseUrl: 'https://api.hubapi.example.com', portalId: '00000000', pipelineId: 'default', dealStageId: 'appointmentscheduled' }, status: 'active', lastSyncedAt: ago(3, 2), createdBy: ADMIN_ID, createdAt: ago(27), updatedAt: ago(3, 2) },
      { workspaceId: A, system: 'csv', name: 'CSV export (finance)', credentialSecretKey: null, config: { delimiter: ';', includeNotes: true }, status: 'active', lastSyncedAt: ago(9), createdBy: MEMBER_ID, createdAt: ago(20), updatedAt: ago(9) },
      { workspaceId: A, system: 'hubspot', name: 'HubSpot (old EU portal)', credentialSecretKey: 'crm.hubspot_legacy', config: { baseUrl: 'https://api-eu1.hubapi.example.com', portalId: '11111111' }, status: 'failing', lastError: '401 Unauthorized: private app token revoked', lastSyncedAt: ago(12), createdBy: ADMIN_ID, createdAt: ago(16), updatedAt: ago(5) },
    ])
    .returning();
  const HUB = must(crmRows[0], 'hubspot').id;
  const CSV = must(crmRows[1], 'csv').id;
  const SF = must(crmRows[2], 'sf').id;
  const syncRow = (k: LeadKey, conn: bigint, kind: s.CrmSyncKind, outcome: s.CrmSyncOutcome, at: Date, extra: Partial<s.NewCrmSyncEntry> = {}): s.NewCrmSyncEntry => ({
    workspaceId: A,
    crmConnectionId: conn,
    qualifiedLeadId: L(k).id,
    kind,
    outcome,
    externalId: outcome === 'succeeded' ? `${between(10000000, 99999999)}` : null,
    statusCode: outcome === 'succeeded' ? 200 : outcome === 'failed' ? 409 : null,
    payload: { email: L(k).contact.email, company: L(k).sd.co.name, product: PRODUCT_LABEL[L(k).product] },
    response: outcome === 'succeeded' ? { id: 'demo', status: 'ok' } : {},
    triggeredBy: ADMIN_ID,
    startedAt: at,
    finishedAt: outcome === 'pending' ? null : plus(at, 2_000),
    createdAt: at,
    ...extra,
  });
  await db.insert(s.crmSyncLog).values([
    syncRow('S1', HUB, 'contact', 'succeeded', ago(11, 2)),
    syncRow('S1', HUB, 'deal', 'succeeded', ago(11, 2)),
    syncRow('S1', HUB, 'note', 'succeeded', ago(11, 1)),
    syncRow('H1', HUB, 'contact', 'succeeded', ago(10, 1)),
    syncRow('H2', HUB, 'contact', 'failed', ago(5, 1), { error: 'Contact already exists (409) — merged manually in HubSpot' }),
    syncRow('X1', HUB, 'deal', 'succeeded', ago(3, 2)),
    syncRow('X1', CSV, 'contact', 'succeeded', ago(9)),
    syncRow('Q3', SF, 'contact', 'failed', ago(5), { statusCode: 401, error: 'Unauthorized: private app token revoked' }),
    syncRow('Q1', HUB, 'contact', 'pending', ago(0, 0, 3)),
  ]);

  // ======================= autopilot =======================
  await db.insert(s.autopilotSettings).values({
    workspaceId: A,
    autopilotEnabled: true,
    emergencyPause: false,
    enableAutoApproveProjects: true,
    autoApproveThreshold: 82,
    enableAutoEnqueueOutreach: true,
    enableAutoDrainQueue: true,
    enableAutoSyncInbound: true,
    enableAutoCrmContactSync: true,
    enableAutoCrmDealOnQualified: false,
    maxApprovalsPerRun: 15,
    maxEnqueuesPerRun: 10,
    defaultMailboxId: MB1.id,
    defaultCrmConnectionId: HUB,
    updatedBy: ADMIN_ID,
    updatedAt: ago(8),
  });
  await db.insert(s.autopilotProductSettings).values([
    { workspaceId: A, productProfileId: P.sealant, autoApproveThreshold: 88, enableAutoEnqueueOutreach: false, updatedBy: ADMIN_ID, updatedAt: ago(7) },
    { workspaceId: A, productProfileId: P.wool, enableAutoEnqueueOutreach: false, defaultMailboxId: MB1.id, updatedBy: MEMBER_ID, updatedAt: ago(10) },
  ]);
  const apRows: s.NewAutopilotLogEntry[] = [];
  const apRuns: [number, number][] = [[0, 3], [1, 2], [2, 4], [4, 1], [6, 5], [9, 3]];
  for (const [d, h] of apRuns) {
    const runId = uuidish();
    const at = ago(d, h);
    const steps: [string, string, string, string | null][] = [
      ['guard', 'success', 'Plan Pro · tokens OK · emergency pause off', null],
      ['auto_sync_inbound', 'success', `Synced 2 mailbox(es): ${between(0, 4)} new inbound message(s)`, null],
      ['auto_approve_projects', d === 4 ? 'skipped' : 'success', d === 4 ? 'No review items above threshold 82' : `Auto-approved ${between(1, 3)} item(s) ≥ 82`, d === 4 ? null : 'review_item'],
      ['auto_enqueue_outreach', 'success', `Enqueued ${between(1, 3)} approved draft(s) to sales@${MAIL_DOMAIN}`, 'outreach_queue'],
      ['auto_drain_queue', d === 1 ? 'error' : 'success', d === 1 ? 'SMTP 421 from smtp.example.com — 1 item will retry' : `Dispatched ${between(1, 4)} queued message(s)`, null],
      ['auto_crm_contact_sync', 'success', 'Pushed 1 contact to HubSpot', 'qualified_lead'],
      ['auto_crm_deal_on_qualified', 'skipped', 'Disabled in workspace settings', null],
    ];
    steps.forEach(([step, outcome, detail, entityType], i) => {
      apRows.push({ workspaceId: A, runId, step, outcome, detail, entityType, entityId: entityType ? `${between(1, 60)}` : null, payload: { runStartedAt: at.toISOString() }, createdAt: plus(at, i * 4_000) });
    });
  }
  await db.insert(s.autopilotLog).values(apRows);

  // ======================= documents / knowledge / RAG =======================
  const docRows = await db
    .insert(s.documents)
    .values([
      { workspaceId: A, name: 'NW-AG10 aerogel blanket — datasheet', filename: 'NW-AG10-datasheet-2026.pdf', mimeType: 'application/pdf', sizeBytes: 412_884, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.pdf`, storageProvider: 'local', status: 'ready', tags: ['datasheet', 'aerogel'], createdBy: MEMBER_ID, createdAt: ago(33), updatedAt: ago(33) },
      { workspaceId: A, name: 'NW-MW Facade — karta techniczna', filename: 'NW-MW-Facade-karta-techniczna.pdf', mimeType: 'application/pdf', sizeBytes: 288_310, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.pdf`, storageProvider: 'local', status: 'ready', tags: ['datasheet', 'wool', 'pl'], createdBy: MEMBER_ID, createdAt: ago(31), updatedAt: ago(31) },
      { workspaceId: A, name: 'NW-FS EN 1366-3 test configurations (summary)', filename: 'NW-FS-EN1366-3-summary.pdf', mimeType: 'application/pdf', sizeBytes: 1_904_221, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.pdf`, storageProvider: 'local', status: 'ready', tags: ['test-report', 'sealant'], createdBy: ADMIN_ID, createdAt: ago(28), updatedAt: ago(28) },
      { workspaceId: A, name: 'Case study — Teesside cold-line retrofit', filename: 'case-study-teesside-retrofit.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 96_512, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.docx`, storageProvider: 'local', status: 'ready', tags: ['case-study'], createdBy: MEMBER_ID, createdAt: ago(21), updatedAt: ago(21) },
      { workspaceId: A, name: 'Price list Q4 2026 (internal)', filename: 'price-list-q4-2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 54_118, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.xlsx`, storageProvider: 'local', status: 'ready', tags: ['internal', 'pricing'], createdBy: ADMIN_ID, createdAt: ago(5), updatedAt: ago(5) },
      { workspaceId: A, name: 'Brand guidelines 2025', filename: 'brand-guidelines-2025.pdf', mimeType: 'application/pdf', sizeBytes: 6_210_004, sha256: hex(64), storageKey: `workspaces/${A}/documents/${uuidish()}.pdf`, storageProvider: 'local', status: 'archived', tags: ['marketing'], createdBy: ADMIN_ID, createdAt: ago(36), updatedAt: ago(14) },
      { workspaceId: A, name: 'Scan — installer training certificate', filename: 'installer-training-scan.pdf', mimeType: 'application/pdf', sizeBytes: 0, sha256: '', storageKey: `workspaces/${A}/documents/${uuidish()}.pdf`, storageProvider: 'local', status: 'failed', tags: [], createdBy: MEMBER_ID, createdAt: ago(2, 3), updatedAt: ago(2, 3) },
    ])
    .returning();
  const doc = (i: number) => must(docRows[i], `doc ${i}`);
  const ksRows = await db
    .insert(s.knowledgeSources)
    .values([
      { workspaceId: A, kind: 'document', documentId: doc(0).id, title: 'AG10 datasheet', summary: 'Thermal conductivity, temperature range, thickness tables and installation notes for NW-AG10.', language: 'en', purposeCategory: 'technical', tags: ['datasheet'], productProfileIds: [P.aerogel], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(33), createdBy: MEMBER_ID, createdAt: ago(33), updatedAt: ago(33) },
      { workspaceId: A, kind: 'document', documentId: doc(1).id, title: 'Karta techniczna NW-MW Facade', summary: 'Parametry płyt 70/90/110 kg/m³, klasyfikacje ogniowe, zalecenia montażowe.', language: 'pl', purposeCategory: 'technical', tags: ['karta-techniczna'], productProfileIds: [P.wool], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(31), createdBy: MEMBER_ID, createdAt: ago(31), updatedAt: ago(31) },
      { workspaceId: A, kind: 'document', documentId: doc(2).id, title: 'EN 1366-3 test configurations', summary: 'Tested penetration configurations (cables, PVC/PE pipes, metal pipes) with EI ratings.', language: 'en', purposeCategory: 'technical', tags: ['test-report'], productProfileIds: [P.sealant], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(28), createdBy: ADMIN_ID, createdAt: ago(28), updatedAt: ago(28) },
      { workspaceId: A, kind: 'document', documentId: doc(3).id, title: 'Teesside retrofit case study', summary: '600 m of cold lines re-insulated in half the usual time using 10 mm AG10.', language: 'en', purposeCategory: 'case_study', tags: ['case-study'], productProfileIds: [P.aerogel], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(21), createdBy: MEMBER_ID, createdAt: ago(21), updatedAt: ago(21) },
      { workspaceId: A, kind: 'url', url: 'https://northwind-insulation.example.com/products/aerogel-blankets', title: 'Aerogel blankets — product page', summary: 'Public product page with applications and FAQs.', language: 'en', purposeCategory: 'marketing', tags: ['website'], productProfileIds: [P.aerogel], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(19), createdBy: ADMIN_ID, createdAt: ago(19), updatedAt: ago(19) },
      { workspaceId: A, kind: 'url', url: 'https://northwind-insulation.example.com/guides/fire-stopping-installation', title: 'Fire stopping installation guide', summary: null, language: 'en', purposeCategory: 'technical', tags: ['guide'], productProfileIds: [P.sealant], externalProviderId: 'pgvector', externalStatus: 'failed', externalError: 'Fetch failed: HTTP 404 Not Found', createdBy: MEMBER_ID, createdAt: ago(6), updatedAt: ago(6) },
      { workspaceId: A, kind: 'text', textExcerpt: 'Objection: "Aerogel is too expensive." Answer: compare installed cost per metre, not material cost — thinner insulation saves scaffolding days and avoids re-spacing lines. Typical payback via labour alone on congested racks.', title: 'Objection handling — price', summary: 'How to answer the "too expensive" objection.', language: 'en', purposeCategory: 'objection_handling', tags: ['sales'], productProfileIds: [P.aerogel], externalProviderId: 'pgvector', externalStatus: 'indexed', externalIndexedAt: ago(12), createdBy: MEMBER_ID, createdAt: ago(12), updatedAt: ago(12) },
      { workspaceId: A, kind: 'text', textExcerpt: 'Internal: we do not yet hold a German abZ for the sealant range; quote EN 1366-3 classification only. Expected abZ Q2 2027.', title: 'Internal note — DE approvals', summary: null, language: 'en', purposeCategory: 'internal_note', tags: ['internal', 'de'], productProfileIds: [P.sealant], externalStatus: 'pending', createdBy: ADMIN_ID, createdAt: ago(0, 6), updatedAt: ago(0, 6) },
    ])
    .returning();
  await db.update(s.productProfiles).set({ documentSourceIds: [doc(0).id, doc(3).id] }).where(eqId(s.productProfiles.id, P.aerogel));
  await db.update(s.productProfiles).set({ documentSourceIds: [doc(1).id] }).where(eqId(s.productProfiles.id, P.wool));
  await db.update(s.productProfiles).set({ documentSourceIds: [doc(2).id] }).where(eqId(s.productProfiles.id, P.sealant));

  const chunkRows: s.NewDocumentChunk[] = [];
  const jobRows: s.NewIndexingJob[] = [];
  for (const ks of ksRows) {
    if (ks.externalStatus !== 'indexed') {
      jobRows.push({ workspaceId: A, knowledgeSourceId: ks.id, status: ks.externalStatus === 'failed' ? 'failed' : 'queued', error: ks.externalError ?? null, startedAt: ks.externalStatus === 'failed' ? ks.createdAt : null, finishedAt: ks.externalStatus === 'failed' ? plus(ks.createdAt, 4_000) : null, triggeredBy: ks.createdBy, createdAt: ks.createdAt });
      continue;
    }
    const n = between(2, 5);
    const base = ks.summary ?? ks.textExcerpt ?? ks.title;
    for (let i = 0; i < n; i++) {
      const content = `${ks.title} — part ${i + 1}. ${base} ${i === 0 ? '' : 'See section ' + (i + 1) + ' for installation details, tolerances and worked examples.'}`.trim();
      chunkRows.push({
        workspaceId: A,
        documentId: ks.documentId,
        knowledgeSourceId: ks.id,
        chunkIndex: i,
        startChar: i * 1800,
        endChar: i * 1800 + content.length,
        content,
        tokenCount: Math.ceil(content.length / 4),
        embedding: null,
        embeddingModel: 'text-embedding-3-small',
        embeddedAt: null,
        metadata: ks.kind === 'document' ? { page: i + 1 } : {},
        createdAt: ks.createdAt,
      });
    }
    jobRows.push({ workspaceId: A, documentId: ks.documentId, knowledgeSourceId: ks.id, status: 'succeeded', chunkCount: n, embeddingModel: 'text-embedding-3-small', startedAt: ks.createdAt, finishedAt: plus(ks.createdAt, between(3, 40) * 1000), triggeredBy: ks.createdBy, createdAt: ks.createdAt });
  }
  jobRows.push({ workspaceId: A, documentId: doc(4).id, status: 'running', startedAt: ago(0, 0, 1), triggeredBy: ADMIN_ID, createdAt: ago(0, 0, 1) });
  await db.insert(s.documentChunks).values(chunkRows);
  await db.insert(s.indexingJobs).values(jobRows);
  await db.insert(s.productVectorStores).values([
    { workspaceId: A, productProfileId: P.aerogel, providerId: 'pgvector', externalStoreId: '', status: 'active', usageBytes: 412_884 + 96_512 + 18_400, fileCount: 4, createdBy: ADMIN_ID, createdAt: ago(33), updatedAt: ago(12) },
    { workspaceId: A, productProfileId: P.wool, providerId: 'pgvector', externalStoreId: '', status: 'active', usageBytes: 288_310, fileCount: 1, createdBy: ADMIN_ID, createdAt: ago(31), updatedAt: ago(31) },
    { workspaceId: A, productProfileId: P.sealant, providerId: 'pgvector', externalStoreId: '', status: 'active', usageBytes: 1_904_221, fileCount: 1, createdBy: ADMIN_ID, createdAt: ago(28), updatedAt: ago(6) },
  ]);

  // ======================= learning =======================
  const LESSONS: { cat: string; rule: string; src: 'operator' | 'draft_edit' | 'synthesis'; product: ProductKey | null; conf: number; enabled?: boolean; apps: number; d: number }[] = [
    { cat: 'qualification_negative', rule: 'Skip residential loft / cavity-wall installers for aerogel — they never buy industrial blankets.', src: 'operator', product: 'aerogel', conf: 92, apps: 41, d: 26 },
    { cat: 'qualification_positive', rule: 'Companies mentioning CUI programmes or cryogenic lines are strong aerogel fits even with a thin website.', src: 'synthesis', product: 'aerogel', conf: 78, apps: 33, d: 18 },
    { cat: 'false_positive', rule: 'Online insulation shops are retailers, not installers — reject even if keywords match.', src: 'operator', product: null, conf: 88, apps: 12, d: 25 },
    { cat: 'outreach_style', rule: 'Keep the first email under 70 words and end with one question about who owns insulation specs.', src: 'draft_edit', product: null, conf: 81, apps: 57, d: 22 },
    { cat: 'outreach_style', rule: 'Do not mention price in the first email; offer a datasheet instead.', src: 'operator', product: 'aerogel', conf: 90, apps: 49, d: 24 },
    { cat: 'contact_role', rule: 'For PL facade contractors, the "Kierownik zakupów" or technical director picks insulation — not the CEO.', src: 'synthesis', product: 'wool', conf: 72, apps: 14, d: 15 },
    { cat: 'sector_preference', rule: 'Data-centre fit-out contractors convert best for fire-rated sealants.', src: 'synthesis', product: 'sealant', conf: 68, apps: 9, d: 11 },
    { cat: 'connector_quality', rule: 'IT directory listings older than 2 years are often defunct companies — verify the website is live.', src: 'operator', product: null, conf: 64, apps: 6, d: 14 },
    { cat: 'dedupe_hint', rule: 'Branches of the same group (e.g. "Berlin" office of Brandschutz Krüger) should be merged as duplicates.', src: 'operator', product: null, conf: 75, apps: 4, d: 2 },
    { cat: 'general_instruction', rule: 'Always write to Polish prospects in Polish, with formal "Pan/Pani" tone.', src: 'operator', product: 'wool', conf: 95, apps: 28, d: 30 },
    { cat: 'reply_quality', rule: 'When a prospect asks for documents, answer in the same thread and summarise the key number in the body.', src: 'draft_edit', product: null, conf: 77, apps: 11, d: 3 },
    { cat: 'product_positioning', rule: 'Position aerogel on installed cost per metre, not material cost per m².', src: 'synthesis', product: 'aerogel', conf: 70, apps: 7, d: 9 },
    { cat: 'qualification_negative', rule: 'Design-only consultancies (Planungsbüro) do not install — mark as not relevant.', src: 'operator', product: 'sealant', conf: 86, apps: 8, d: 19 },
    { cat: 'false_negative', rule: 'Tender buyers (councils, NHS trusts) are not customers, but their awarded contractors are — follow the award notice.', src: 'synthesis', product: 'sealant', conf: 62, apps: 3, d: 6 },
    { cat: 'outreach_style', rule: 'Avoid the phrase "game-changer" — operators remove it every time.', src: 'draft_edit', product: null, conf: 84, apps: 19, d: 12 },
    { cat: 'contact_role', rule: 'At UK fire-stopping firms, the Contracts Manager selects products; office managers redirect.', src: 'synthesis', product: 'sealant', conf: 66, apps: 2, d: 4 },
    { cat: 'qualification_positive', rule: 'Biogas service companies are out of scope for now.', src: 'operator', product: null, conf: 55, enabled: false, apps: 0, d: 7 },
    { cat: 'general_instruction', rule: 'For German prospects, never claim an abZ approval for sealants — quote EN 1366-3 only.', src: 'operator', product: 'sealant', conf: 97, apps: 6, d: 1 },
    { cat: 'reply_quality', rule: 'Out-of-office replies should not cancel the follow-up sequence.', src: 'operator', product: null, conf: 80, apps: 5, d: 10 },
    { cat: 'sector_preference', rule: 'Prefer cold-store and food-processing contractors in East Anglia for aerogel trials (short decision cycles).', src: 'synthesis', product: 'aerogel', conf: 58, enabled: false, apps: 1, d: 0 },
  ];
  const lessonRows = await db
    .insert(s.learningLessons)
    .values(
      LESSONS.map((l) => ({
        workspaceId: A,
        productProfileId: l.product ? P[l.product] : null,
        category: l.cat,
        rule: l.rule,
        source: l.src,
        enabled: l.enabled ?? true,
        confidence: l.conf,
        applicationCount: l.apps,
        lastAppliedAt: l.apps > 0 ? ago(between(0, Math.max(0, l.d - 1)), between(0, 20)) : null,
        createdBy: l.src === 'synthesis' ? null : pick([ADMIN_ID, MEMBER_ID]),
        updatedBy: null,
        createdAt: ago(l.d, between(1, 20)),
        updatedAt: ago(Math.max(0, l.d - 1)),
      })),
    )
    .returning();
  const eventRows: s.NewLearningEvent[] = [];
  lessonRows.forEach((lesson, i) => {
    const spec = must(LESSONS[i], 'lesson spec');
    const n = spec.src === 'synthesis' ? 3 : 1;
    for (let j = 0; j < n; j++) {
      const sd = pick(seeded);
      eventRows.push({
        workspaceId: A,
        userId: spec.src === 'synthesis' ? pick([MEMBER_ID, ADMIN_ID]) : lesson.createdBy,
        entityType: spec.src === 'draft_edit' ? 'outreach_draft' : 'review_item',
        entityId: sd.reviewItemId.toString(),
        productProfileId: lesson.productProfileId,
        actionType: spec.cat,
        originalComment: spec.src === 'draft_edit' ? 'Operator shortened the draft and removed the price mention.' : pick(['Not our customer.', 'Good fit — keep these.', 'Wrong person, redirect next time.', 'Duplicate branch.', null]),
        extractedLessonId: lesson.id,
        confidence: spec.conf,
        createdAt: plus(lesson.createdAt, -between(1, 48) * HOUR),
      });
    }
  });
  for (let i = 0; i < 6; i++) {
    const sd = must(seeded[between(0, seeded.length - 1)], 'sd');
    eventRows.push({ workspaceId: A, userId: MEMBER_ID, entityType: 'review_item', entityId: sd.reviewItemId.toString(), productProfileId: P[sd.primary], actionType: pick(['qualification_negative', 'qualification_positive']), originalComment: pick(['meh', 'Not sure about this one', null]), confidence: 40, createdAt: ago(between(0, 20), between(0, 20)) });
  }
  await db.insert(s.learningEvents).values(eventRows);
  // link a couple of drafts to lessons
  const outreachLessonIds = lessonRows.filter((l) => l.category === 'outreach_style').map((l) => l.id);
  if (outreachLessonIds.length > 0) {
    await db
      .update(s.outreachDrafts)
      .set({ matchedLessonIds: outreachLessonIds })
      .where(and(eq(s.outreachDrafts.workspaceId, A), eq(s.outreachDrafts.stage, 'discovery')));
  }

  // ======================= notifications =======================
  const p1Thread = must(leadThreads.get('P1')?.[0], 'P1 thread').threadId;
  const p2Thread = must(leadThreads.get('P2')?.[0], 'P2 thread').threadId;
  const p3Thread = must(leadThreads.get('P3')?.[0], 'P3 thread').threadId;
  const failedRun = must(ctx.runRows[7], 'failed run');
  const failedRun2 = must(ctx.runRows[6], 'failed run 2');
  const unverified = must(seeded.find((x) => x.co.outcome === 'unverified'), 'unverified');
  const mentionItem = must(seeded.find((x) => x.co.name === 'Insul8 Group'), 'mention item');
  await db.insert(s.notifications).values([
    { workspaceId: A, kind: 'lead.replied', title: 'Sarah Holloway (Humber Process Insulation) replied — positive', body: 'Timing is actually good. We are re-insulating about 400 m of 150 mm cold lines…', href: `/communication/${p1Thread}`, dedupeKey: `lead.replied:${p1Thread}`, createdAt: ago(1, 2) },
    { workspaceId: A, kind: 'lead.replied', title: 'Agnieszka Zielińska (Budmax Fasady) asked a question', body: 'Jaka jest minimalna ilość zamówienia…', href: `/communication/${p2Thread}`, dedupeKey: `lead.replied:${p2Thread}`, createdAt: ago(2, 2) },
    { workspaceId: A, kind: 'lead.replied', title: 'Markus Becker (Isoliertechnik Rhein-Ruhr) requested documents', body: 'Bitte senden Sie uns das technische Datenblatt…', href: `/communication/${p3Thread}`, readAt: ago(2, 8), createdAt: ago(3, 2) },
    { workspaceId: A, kind: 'follow_up.awaiting_approval', title: '3 follow-ups are waiting for your approval', body: 'Termo-Izol Gdańsk (step 2), Brandschutz Krüger (step 1), Midlands Firestop (final step).', href: '/communication/follow-ups', dedupeKey: 'follow_up.awaiting_approval', createdAt: ago(0, 1) },
    { workspaceId: A, kind: 'review.needs_review', title: '4 leads need a location check', body: 'Relevant, but no location evidence for the target country (GB). Verify before outreach.', href: '/review?state=needs_review', dedupeKey: 'review.needs_review:geo', createdAt: ago(8, 3) },
    { workspaceId: A, kind: 'run.failed', title: 'Run failed: DE Brandschutz-Fachbetriebe — Abschottungen', body: 'Timeout fetching results page 3 after 30000 ms', href: `/connectors/${ctx.CONN_WEB}/runs/${failedRun.id}`, dedupeKey: `run.failed:${failedRun.id}`, createdAt: ago(2, 6) },
    { workspaceId: A, kind: 'run.failed', title: 'Run failed: PL wykonawcy fasad i izolacji — wełna mineralna', body: 'SerpAPI returned HTTP 429 (rate limit exceeded)', href: `/connectors/${ctx.CONN_WEB}/runs/${failedRun2.id}`, readAt: ago(3, 20), createdAt: ago(4, 1) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'mention', title: 'Jordan Avery mentioned you on Insul8 Group', body: '@Marta can you check if they are the same group as Global Thermal?', href: `/review/${mentionItem.reviewItemId}`, createdAt: ago(5, 4) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'assignment', title: 'You were assigned: Global Thermal Solutions', body: 'Please verify location before approving.', href: `/review/${unverified.reviewItemId}`, readAt: ago(7), createdAt: ago(8, 2) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'assignment', title: 'You were assigned: Hessen Rohrleitungsbau (draft needs edit)', href: `/drafts`, createdAt: ago(3, 5) },
    { workspaceId: A, kind: 'health.warning', title: 'Workspace health: 3 warnings (score 78)', body: 'A mailbox is failing, 2 runs failed this week, follow-ups are waiting for approval.', href: '/health', dedupeKey: 'health.warning', createdAt: ago(1, 4) },
    { workspaceId: A, kind: 'support.reply', title: 'Support replied: IMAP sync stopped on legacy mailbox', body: 'We checked the logs — the server rejects the stored password…', href: '/support/1', dedupeKey: 'support.reply:1', createdAt: ago(0, 5) },
    { workspaceId: A, kind: 'learning.synthesis', title: '4 new lessons proposed by weekly self-learning', body: 'Review the suggested rules on the Learning page.', href: '/learning', readAt: ago(3), createdAt: ago(4, 6) },
    { workspaceId: A, kind: 'lead.replied', title: 'Ian McLeod (Grampian Energy) — added to approved supplier list', href: `/pipeline/${L('S1').id}`, readAt: ago(15), createdAt: ago(16, 2) },
    { workspaceId: B, kind: 'tokens.low', title: 'Tokens running low (312 left)', body: 'Your trial ends in 3 days.', href: '/settings/billing', dedupeKey: 'tokens.low', createdAt: ago(1) },
  ]);

  // ======================= health reports =======================
  const c6Thread = must(leadThreads.get('C6')?.[0], 'C6 thread').threadId;
  const q1Thread = must(leadThreads.get('Q1')?.[0], 'Q1 thread').threadId;
  await db.insert(s.workspaceHealthReports).values([
    {
      workspaceId: A,
      score: 64,
      findings: [
        { severity: 'warning', code: 'mailbox.failing', message: 'Mailbox "Legacy outreach" has failed IMAP sync 4 times in a row.', href: `/mailbox/${MB3.id}` },
        { severity: 'warning', code: 'drafts.stale', message: '9 drafts have been waiting for review for more than 3 days.', href: '/drafts' },
        { severity: 'warning', code: 'knowledge.missing', message: 'Product "Fire-rated sealants" has only one knowledge source.', href: `/products/${P.sealant}` },
        { severity: 'info', code: 'crm.unsynced', message: '2 qualified leads are not synced to the CRM.', href: '/pipeline' },
      ],
      commReview: [
        { threadId: c6Thread.toString(), subject: 'Penetration sealing on Midlands Firestop Solutions projects', naturalness: 72, issues: ['Follow-up 2 repeats the opening line of the first email.'], advice: ['Vary the opener in follow-ups; reference something new (case study, event).'] },
      ],
      advice: ['Fix the legacy mailbox password or archive it.', 'Clear the draft backlog — stale drafts lower reply rates.', 'Add the installation guide as a knowledge source for sealants.'],
      createdAt: ago(8, 4),
    },
    {
      workspaceId: A,
      score: 78,
      findings: [
        { severity: 'warning', code: 'mailbox.failing', message: 'Mailbox "Legacy outreach" is failing: IMAP AUTHENTICATIONFAILED.', href: `/mailbox/${MB3.id}` },
        { severity: 'warning', code: 'runs.failed', message: '2 connector runs failed in the last 7 days (rate limit, timeout).', href: '/connectors' },
        { severity: 'warning', code: 'follow_ups.pending', message: '3 follow-ups are waiting for approval; the oldest is 6 hours overdue.', href: '/communication/follow-ups' },
        { severity: 'info', code: 'review.backlog', message: '4 relevant leads have unverified location (target GB).', href: '/review?state=needs_review' },
        { severity: 'info', code: 'knowledge.index_failed', message: 'Knowledge source "Fire stopping installation guide" failed to index (404).', href: '/knowledge' },
      ],
      commReview: [
        { threadId: q1Thread.toString(), subject: 'Pipe insulation specs at Clydeside Thermal Engineering', naturalness: 91, issues: [], advice: ['Good pacing; the pitch reused the prospect’s own numbers.'] },
        { threadId: c6Thread.toString(), subject: 'Penetration sealing on Midlands Firestop Solutions projects', naturalness: 76, issues: ['Final follow-up is still a bit generic.'], advice: ['Mention the NHS framework award in the final email.'] },
      ],
      advice: ['Archive or fix the legacy mailbox.', 'Lower the SerpAPI query rate for the PL plan or spread queries over the week.', 'Approve or edit pending follow-ups today.'],
      createdAt: ago(1, 4),
    },
  ]);

  // ======================= support =======================
  const [sup1] = await db
    .insert(s.supportThreads)
    .values({ workspaceId: A, subject: 'IMAP sync stopped on legacy mailbox', status: 'open', createdByUserId: MEMBER_ID, lastMessageAt: ago(0, 5), customerUnread: true, adminUnread: false, createdAt: ago(1, 3), updatedAt: ago(0, 5) })
    .returning();
  const [sup2] = await db
    .insert(s.supportThreads)
    .values({ workspaceId: A, subject: 'Invoice for September top-up', status: 'closed', createdByUserId: ADMIN_ID, lastMessageAt: ago(18), customerUnread: false, adminUnread: false, createdAt: ago(20), updatedAt: ago(18) })
    .returning();
  const [sup3] = await db
    .insert(s.supportThreads)
    .values({ workspaceId: B, subject: 'How do I import my existing customer list?', status: 'open', createdByUserId: LENA_ID, lastMessageAt: ago(0, 9), customerUnread: false, adminUnread: true, createdAt: ago(0, 9), updatedAt: ago(0, 9) })
    .returning();
  await db.insert(s.supportMessages).values([
    { threadId: must(sup1, 's1').id, workspaceId: A, senderKind: 'customer', senderUserId: MEMBER_ID, body: 'Hi! The legacy outreach mailbox shows "failing" since yesterday. Nothing changed on our side as far as I know. Can you check?', createdAt: ago(1, 3) },
    { threadId: must(sup1, 's1').id, workspaceId: A, senderKind: 'admin', senderUserId: ADMIN_ID, body: 'We checked the logs — the IMAP server rejects the stored password (AUTHENTICATIONFAILED). It was probably rotated on the mail server. Please update it under Mailbox → Edit, then press Sync.', createdAt: ago(0, 5) },
    { threadId: must(sup2, 's2').id, workspaceId: A, senderKind: 'customer', senderUserId: ADMIN_ID, body: 'Could you send a VAT invoice for the auto top-up on the 10th?', createdAt: ago(20) },
    { threadId: must(sup2, 's2').id, workspaceId: A, senderKind: 'admin', senderUserId: ADMIN_ID, body: 'Done — the invoice is available in Settings → Billing → Invoices. Closing this thread.', createdAt: ago(18) },
    { threadId: must(sup3, 's3').id, workspaceId: B, senderKind: 'customer', senderUserId: LENA_ID, body: 'We have ~300 existing customers in Excel. Can we import them so they are excluded from outreach?', createdAt: ago(0, 9) },
  ]);

  // ======================= usage + token ledger =======================
  const USAGE_KINDS: { kind: string; provider: string; perDay: [number, number]; units: [number, number]; cents: [number, number] }[] = [
    { kind: 'ai.qualification', provider: 'gemini', perDay: [1, 3], units: [18_000, 90_000], cents: [10, 32] },
    { kind: 'ai.outreach', provider: 'openai', perDay: [1, 3], units: [3_000, 9_000], cents: [6, 18] },
    { kind: 'ai.suggestion', provider: 'openai', perDay: [0, 2], units: [1_500, 4_000], cents: [3, 9] },
    { kind: 'ai.assistant', provider: 'anthropic', perDay: [0, 2], units: [2_000, 12_000], cents: [5, 24] },
    { kind: 'research.query', provider: 'gemini', perDay: [0, 2], units: [1, 1], cents: [6, 14] },
    { kind: 'search.query', provider: 'serpapi', perDay: [1, 3], units: [4, 12], cents: [5, 15] },
    { kind: 'embedding.embed', provider: 'openai', perDay: [0, 1], units: [5_000, 60_000], cents: [1, 3] },
    { kind: 'rag.index_knowledge_source', provider: 'openai', perDay: [0, 0], units: [3, 12], cents: [1, 2] },
    { kind: 'ocr.pdf', provider: 'mistral', perDay: [0, 0], units: [2, 14], cents: [2, 8] },
    { kind: 'ai.health_check', provider: 'anthropic', perDay: [0, 0], units: [20_000, 40_000], cents: [40, 70] },
    { kind: 'ai.learning_synthesis', provider: 'openai', perDay: [0, 0], units: [10_000, 30_000], cents: [15, 35] },
  ];
  const usagePayload = (kind: string, provider: string, units: number): Record<string, unknown> => {
    const model =
      provider === 'gemini' ? 'gemini-2.5-flash' : provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'mistral' ? 'mistral-ocr-latest' : kind === 'embedding.embed' || kind.startsWith('rag.') ? 'text-embedding-3-small' : 'gpt-5-mini';
    if (kind.startsWith('ai.')) {
      const inputTokens = Math.round(units * 0.82);
      return { model, inputTokens, outputTokens: units - inputTokens, keySource: 'platform' };
    }
    if (kind === 'embedding.embed') return { model, inputTokens: units, batchSize: between(8, 64), keySource: 'platform' };
    if (kind === 'search.query') return { query: pick(RECIPES.flatMap((r) => r.queries)), keySource: 'platform' };
    if (kind === 'research.query') return { keySource: 'platform', inputTokens: between(800, 2400), outputTokens: between(300, 900), searchQueries: between(2, 5) };
    if (kind === 'ocr.pdf') return { model, filename: pick(['NW-FS-EN1366-3-summary.pdf', 'supplier-cert-scan.pdf']), pages: units, keySource: 'platform' };
    if (kind.startsWith('rag.')) return { chunkCount: units, model };
    return { keySource: 'platform' };
  };
  const usageRows: s.NewUsageLogEntry[] = [];
  for (let d = 29; d >= 0; d--) {
    for (const k of USAGE_KINDS) {
      let n = between(k.perDay[0], k.perDay[1]);
      if ((k.kind === 'ai.health_check' && (d === 8 || d === 1)) || (k.kind === 'ai.learning_synthesis' && (d === 4 || d === 11 || d === 18 || d === 25))) n = 1;
      if ((k.kind === 'rag.index_knowledge_source' || k.kind === 'ocr.pdf') && [33, 31, 28, 21, 19, 12, 6].map((x) => x - 4).includes(d)) n = 1;
      for (let i = 0; i < n; i++) {
        const cents = between(k.cents[0], k.cents[1]);
        const units = between(k.units[0], k.units[1]);
        usageRows.push({
          workspaceId: A,
          kind: k.kind,
          provider: k.provider,
          units: BigInt(units),
          costEstimateCents: cents,
          payload: usagePayload(k.kind, k.provider, units),
          createdAt: ago(d, between(0, 14), between(0, 59)),
        });
      }
    }
    // a little BYOK and mock traffic (never debited)
    if (d % 6 === 0) usageRows.push({ workspaceId: A, kind: 'ai.outreach', provider: 'openai', units: 4200n, costEstimateCents: 11, payload: { model: 'gpt-5-mini', inputTokens: 3400, outputTokens: 800, keySource: 'workspace' }, createdAt: ago(d, 3) });
    if (d % 10 === 0) usageRows.push({ workspaceId: A, kind: 'ai.qualification', provider: 'mock', units: 1n, costEstimateCents: 0, payload: { model: 'mock', inputTokens: 1, outputTokens: 0, keySource: 'mock' }, createdAt: ago(d, 4) });
  }
  usageRows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
  const insertedUsage = await db.insert(s.usageLog).values(usageRows).returning();

  // Ledger: credits + one debit per billable usage row, replayed chronologically.
  interface LedgerItem { at: Date; delta: bigint; kind: string; reason: string; externalRef?: string; payload: Record<string, unknown> }
  const ledger: LedgerItem[] = [
    { at: ago(38), delta: 500n, kind: 'adjustment', reason: 'Welcome allowance', payload: { welcome: true } },
    { at: ago(30, 6), delta: 13_000n, kind: 'purchase', reason: 'subscription.allowance:pro', externalRef: 'invoice:in_demo_2026_09', payload: { stripeInvoiceId: 'in_demo_2026_09', plan: 'pro', amountPaid: 9900, currency: 'eur' } },
    { at: ago(21), delta: 5_500n, kind: 'purchase', reason: 'pack_m', externalRef: 'cs_demo_pack_m_0910', payload: { stripeSessionId: 'cs_demo_pack_m_0910', amountTotal: 4900, currency: 'eur' } },
  ];
  let totalDebit = 0n;
  for (const u of insertedUsage) {
    const keySource = (u.payload as Record<string, unknown>).keySource;
    if (u.provider === 'mock' || keySource === 'workspace' || keySource === 'mock') continue;
    if (!u.costEstimateCents) continue;
    const tokens = Math.max(1, Math.ceil(u.costEstimateCents * 3));
    totalDebit += BigInt(tokens);
    ledger.push({ at: u.createdAt, delta: BigInt(-tokens), kind: 'usage', reason: u.kind, payload: { usageLogId: u.id.toString(), provider: u.provider, costEstimateCents: u.costEstimateCents, units: u.units.toString() } });
  }
  // A goodwill credit sized so the wallet lands on ~8,200 (falls back to 250).
  const target = 8_200n;
  let goodwill: bigint | null = target - (500n + 13_000n + 5_500n) + totalDebit;
  if (goodwill < 50n) goodwill = null; // already within a few dozen tokens of the target
  else if (goodwill > 2_500n) goodwill = 250n;
  if (goodwill !== null) {
    ledger.push({ at: ago(9, 2), delta: goodwill, kind: 'adjustment', reason: 'Goodwill credit — failed PL crawl (rate limit)', payload: { actorUserId: ADMIN_ID } });
  }
  ledger.sort((a, b) => a.at.getTime() - b.at.getTime());
  let bal = 0n;
  const txRows: s.NewTokenTransaction[] = ledger.map((l) => {
    bal += l.delta;
    return { workspaceId: A, delta: l.delta, balanceAfter: bal, kind: l.kind, reason: l.reason, externalRef: l.externalRef ?? null, payload: l.payload, createdAt: l.at };
  });
  await db.insert(s.tokenTransactions).values(txRows);
  await db.update(s.workspaces).set({ tokenBalance: bal }).where(eqId(s.workspaces.id, A));
  console.log(`workspace A token balance after replay: ${bal}`);

  // Workspace B: welcome + a few debits
  const bUsage: s.NewUsageLogEntry[] = [
    { workspaceId: B, kind: 'search.query', provider: 'serpapi', units: 6n, costEstimateCents: 9, payload: { keySource: 'platform' }, createdAt: ago(8, 3) },
    { workspaceId: B, kind: 'ai.qualification', provider: 'gemini', units: 22_000n, costEstimateCents: 14, payload: { keySource: 'platform' }, createdAt: ago(8, 2) },
    { workspaceId: B, kind: 'ai.suggestion', provider: 'openai', units: 2_100n, costEstimateCents: 4, payload: { keySource: 'platform' }, createdAt: ago(9, 5) },
    { workspaceId: B, kind: 'ai.assistant', provider: 'anthropic', units: 6_400n, costEstimateCents: 12, payload: { keySource: 'platform' }, createdAt: ago(2, 1) },
  ];
  const bIns = await db.insert(s.usageLog).values(bUsage).returning();
  let bBal = 500n;
  const bTx: s.NewTokenTransaction[] = [{ workspaceId: B, delta: 500n, balanceAfter: 500n, kind: 'adjustment', reason: 'Welcome allowance', payload: { welcome: true }, createdAt: ago(11) }];
  for (const u of bIns.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const t = BigInt(Math.max(1, Math.ceil((u.costEstimateCents ?? 0) * 3)));
    bBal -= t;
    bTx.push({ workspaceId: B, delta: -t, balanceAfter: bBal, kind: 'usage', reason: u.kind, payload: { usageLogId: u.id.toString(), provider: u.provider }, createdAt: u.createdAt });
  }
  // a small promo so B lands at a "free plan" looking balance
  bBal += 0n;
  await db.insert(s.tokenTransactions).values(bTx);
  await db.update(s.workspaces).set({ tokenBalance: bBal }).where(eqId(s.workspaces.id, B));

  // ======================= audit log =======================
  const audit: s.NewAuditLogEntry[] = [
    { workspaceId: A, userId: ADMIN_ID, kind: 'workspace.bootstrap', entityType: 'workspace', entityId: A.toString(), payload: { name: 'Northwind Insulation (demo)' }, createdAt: ago(38) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'user.add_member', entityType: 'user', entityId: MEMBER_ID, payload: { email: 'demo-member@example.com', role: 'manager' }, createdAt: ago(35) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'product_profile.create', entityType: 'product_profile', entityId: P.aerogel.toString(), payload: { name: 'Aerogel insulation blankets' }, createdAt: ago(37) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'product_profile.create', entityType: 'product_profile', entityId: P.wool.toString(), payload: { name: 'Mineral wool panels' }, createdAt: ago(36) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'product_profile.create', entityType: 'product_profile', entityId: P.sealant.toString(), payload: { name: 'Fire-rated sealants' }, createdAt: ago(30) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'product_profile.update', entityType: 'product_profile', entityId: P.aerogel.toString(), payload: { fields: ['outreachInstructions', 'forbiddenPhrases'] }, createdAt: ago(6) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'secret.set', entityType: 'workspace_secret', entityId: 'mailbox.smtpPassword', payload: { scope: 'mailbox' }, createdAt: ago(34) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'provider_settings.update', entityType: 'workspace', entityId: A.toString(), payload: { aiProvider: 'openai', qualificationProvider: 'gemini' }, createdAt: ago(18) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'outreach.send_settings.update', entityType: 'workspace', entityId: A.toString(), payload: { dailyEmailLimit: 60, domainCooldownHours: 48 }, createdAt: ago(12) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'reply_auto_actions.changed', entityType: 'workspace', entityId: A.toString(), payload: { changes: { autoSuppressUnsubscribe: { from: false, to: true }, autoSuppressBounce: { from: false, to: true }, autoCloseNegative: { from: false, to: true } }, after: { autoSuppressUnsubscribe: true, autoSuppressBounce: true, autoCloseNegative: true, autoExtractRedirects: true } }, createdAt: ago(15) },
    ...(goodwill !== null
      ? [{ workspaceId: A, userId: ADMIN_ID, kind: 'tokens.adjust', entityType: 'workspace', entityId: A.toString(), payload: { delta: goodwill.toString(), reason: 'Goodwill credit — failed PL crawl (rate limit)' }, createdAt: ago(9, 2) }]
      : []),
    { workspaceId: A, userId: MEMBER_ID, kind: 'suppression.add', entityType: 'suppression', entityId: 'leeds city council', payload: { kind: 'company', reason: 'manual' }, createdAt: ago(18) },
    { workspaceId: A, userId: null, kind: 'suppression.add', entityType: 'suppression', entityId: 'marek.dabrowski@izolbud-slask.example.pl', payload: { kind: 'email', reason: 'bounce_hard', auto: true }, createdAt: ago(19, 4) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'signature.create', entityType: 'signature', entityId: '1', payload: { name: 'Marta — sales (EN)' }, createdAt: ago(33) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'outreach.queue.cancel', entityType: 'outreach_queue', entityId: null, payload: { subject: 'Samples for your cold store project' }, createdAt: ago(4, 1) },
    { workspaceId: A, userId: null, kind: 'outreach.geo_blocked', entityType: 'review_item', entityId: must(seeded.find((x) => x.co.outcome === 'mismatch'), 'mm').reviewItemId.toString(), payload: { geoStatus: 'mismatch' }, createdAt: ago(26) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'review.comment', entityType: 'review_item', entityId: mentionItem.reviewItemId.toString(), payload: {}, createdAt: ago(5, 4) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'review.assign', entityType: 'review_item', entityId: unverified.reviewItemId.toString(), payload: { assignedTo: MEMBER_ID }, createdAt: ago(8, 2) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'outreach.reject', entityType: 'outreach_draft', entityId: null, payload: { reason: 'Residential installer' }, createdAt: ago(25) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'knowledge.compaction.run', entityType: 'workspace', entityId: A.toString(), payload: { mergedClusters: 1, retiredMergedCount: 2, retiredStaleCount: 1 }, createdAt: ago(7) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'rag.index_document', entityType: 'document', entityId: doc(0).id.toString(), payload: { chunks: 4 }, createdAt: ago(33) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'mail.send_test', entityType: 'mailbox', entityId: MB2.id.toString(), payload: { ok: true }, createdAt: ago(29, 2) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'mail.mark_as_spam', entityType: 'mail_message', entityId: null, payload: { from: 'promo@cheap-leads.example.net' }, createdAt: ago(3, 8) },
    { workspaceId: A, userId: MEMBER_ID, kind: 'support.thread.create', entityType: 'support_thread', entityId: must(sup1, 's1').id.toString(), payload: {}, createdAt: ago(1, 3) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'user.set_account_status', entityType: 'user', entityId: SUSPENDED_ID, payload: { status: 'suspended' }, createdAt: ago(6) },
    { workspaceId: null, userId: ADMIN_ID, kind: 'user.set_account_status', entityType: 'user', entityId: '0d3e0000-0000-4000-8000-00000000a007', payload: { status: 'rejected' }, createdAt: ago(9) },
    { workspaceId: null, userId: ADMIN_ID, kind: 'platform_settings.update', entityType: 'platform', entityId: 'ai.provider', payload: { value: 'openai' }, createdAt: ago(25) },
    { workspaceId: B, userId: ADMIN_ID, kind: 'workspace.bootstrap', entityType: 'workspace', entityId: B.toString(), payload: { name: 'Baltic Steel Trading (demo)' }, createdAt: ago(11) },
    { workspaceId: C, userId: ADMIN_ID, kind: 'workspace.archive', entityType: 'workspace', entityId: C.toString(), payload: { reason: 'Pilot finished' }, createdAt: ago(28) },
    { workspaceId: A, userId: ADMIN_ID, kind: 'workspace.god_mode_switch', entityType: 'workspace', entityId: B.toString(), payload: { from: A.toString(), to: B.toString() }, createdAt: ago(2, 6) },
  ];
  for (const lead of leads.values()) {
    if (lead.plan.state === 'relevant') continue;
    audit.push({ workspaceId: A, userId: userFor(lead.plan.assignee), kind: 'pipeline.transition', entityType: 'qualified_lead', entityId: lead.id.toString(), payload: { to: lead.plan.state }, createdAt: ago(Math.min(lead.plan.closedAgo ?? 99, lead.plan.qualifiedAgo ?? 99, lead.plan.repliedAgo ?? 99, lead.plan.contactedAgo ?? 99), 1) });
    audit.push({ workspaceId: A, userId: userFor(lead.plan.assignee), kind: 'outreach.enqueue', entityType: 'outreach_draft', entityId: (activeDraft.get(lead.key) ?? 0n).toString(), payload: { mailbox: 'sales' }, createdAt: ago(lead.plan.contactedAgo ?? 1, 6) });
  }
  await db.insert(s.auditLog).values(audit);

  // ======================= admin bits =======================
  await db.insert(s.featureFlags).values([
    { workspaceId: A, key: 'crm.hubspot', enabled: true, config: {}, setBy: ADMIN_ID, setAt: ago(27) },
    { workspaceId: A, key: 'outreach.send', enabled: true, config: {}, setBy: ADMIN_ID, setAt: ago(34) },
    { workspaceId: A, key: 'rag.openai', enabled: false, config: {}, setBy: ADMIN_ID, setAt: ago(20) },
    { workspaceId: A, key: 'mailbox.imap_sync', enabled: true, config: {}, setBy: ADMIN_ID, setAt: ago(34) },
    { workspaceId: A, key: 'connector.serpapi', enabled: true, config: {}, setBy: ADMIN_ID, setAt: ago(37) },
    { workspaceId: B, key: 'outreach.send', enabled: false, config: {}, setBy: ADMIN_ID, setAt: ago(10) },
    { workspaceId: B, key: 'connector.serpapi', enabled: true, config: {}, setBy: ADMIN_ID, setAt: ago(10) },
  ]);
  await db.insert(s.impersonationSessions).values([
    { actorUserId: ADMIN_ID, targetUserId: LENA_ID, targetWorkspaceId: B, reason: 'Help with onboarding wizard (support thread)', startedAt: ago(2, 6), endedAt: ago(2, 5, 40), endedByUserId: ADMIN_ID },
  ]);
  await db.insert(s.platformSettings).values([
    { key: 'ai.provider', value: 'openai', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
    { key: 'ai.model', value: 'gpt-5-mini', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
    { key: 'research.provider', value: 'gemini', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
    { key: 'research.model', value: 'gemini-2.5-flash', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
    { key: 'search.provider', value: 'serpapi', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
    { key: 'embedding.provider', value: 'openai', updatedByUserId: ADMIN_ID, updatedAt: ago(25) },
  ]);

  // ======================= workspace B content =======================
  const bCompanies: [string, string, string, boolean][] = [
    ['Klaipėda Metal Works', 'klaipeda-metal.example.lt', 'Structural steel fabrication for port warehouses and cranes.', true],
    ['Pomorska Wytwórnia Konstrukcji', 'pwk-stal.example.pl', 'Wytwórnia konstrukcji stalowych, hale i estakady.', true],
    ['Riga Steel Frames', 'riga-frames.example.lv', 'Steel frames for logistics halls across Latvia.', true],
    ['Tallinn Shipyard Services', 'tallinn-shipyard.example.ee', 'Ship repair yard — buys plate for hull repairs.', false],
    ['Gdynia Scrap & Recycling', 'gdynia-scrap.example.pl', 'Scrap metal collection and recycling.', false],
  ];
  for (const [i, [name, domain, snippet, rel]] of bCompanies.entries()) {
    const at = ago(8, 2, i * 3);
    const [sr] = await db
      .insert(s.sourceRecords)
      .values({ workspaceId: B, sourceSystem: `connector:${ctx.CONN_B}`, sourceId: `b:${domain}`, sourceUrl: `https://www.${domain}/`, connectorId: ctx.CONN_B, recipeId: ctx.recipeB, rawData: { title: name }, normalizedData: { title: name, url: `https://www.${domain}/`, domain, snippet }, confidence: 55, createdAt: at, updatedAt: at })
      .returning();
    const srId = must(sr, 'B sr').id;
    await db.insert(s.qualifications).values({
      workspaceId: B,
      sourceRecordId: srId,
      productProfileId: i === 3 ? ctx.PROD_B2 : ctx.PROD_B1,
      isRelevant: rel,
      relevanceScore: rel ? between(62, 84) : between(15, 35),
      confidence: between(55, 80),
      qualificationReason: rel ? 'Fabricator buying structural sections.' : null,
      rejectionReason: rel ? null : 'Not a buyer of new steel sections.',
      matchedKeywords: rel ? ['steel fabrication'] : [],
      evidence: { contributions: [{ kind: 'ai_score', value: 'demo', delta: 0 }], matchedLessonIds: [] },
      method: 'ai',
      model: 'gemini-2.5-flash',
      geoStatus: 'no_gate',
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(s.reviewItems).values({ workspaceId: B, sourceRecordId: srId, state: i === 0 ? 'approved' : rel ? 'new' : 'rejected', approvedByUserId: i === 0 ? LENA_ID : null, approvedAt: i === 0 ? ago(7) : null, rejectedAt: rel ? null : ago(7), rejectionReason: rel ? null : 'Not a buyer', createdAt: at, updatedAt: at });
  }
  await db.insert(s.connectorRuns).values({ workspaceId: B, connectorId: ctx.CONN_B, recipeId: ctx.recipeB, productProfileIds: [ctx.PROD_B1, ctx.PROD_B2], status: 'succeeded', progress: 100, recordCount: bCompanies.length, startedAt: ago(8, 2, 10), completedAt: ago(8, 1, 58), recipeSnapshot: { country: 'PL' }, createdAt: ago(8, 2, 10), updatedAt: ago(8, 1, 58) });

  // Workspace C (archived) — a little history
  await db.insert(s.productProfiles).values({ workspaceId: C, name: 'Pilot product (archived)', shortDescription: 'Pilot-era product profile.', language: 'en', active: false, createdBy: ctx.PILOT_ID, createdAt: ago(88), updatedAt: ago(30) });

  // touch PENDING user so lint doesn't complain about an unused binding
  void PENDING_ID;
}

function eqId(col: Parameters<typeof eq>[0], id: bigint) {
  return eq(col, id);
}

async function insertThread(workspaceId: bigint, mailboxId: bigint, subject: string, participants: string[], at: Date): Promise<bigint> {
  const [row] = await db
    .insert(s.mailThreads)
    .values({
      workspaceId,
      mailboxId,
      subject,
      externalThreadKey: `ext-${hex(16)}`,
      messageCount: 1,
      lastMessageAt: at,
      participants: participants.map((p) => p.toLowerCase()),
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return must(row, 'thread').id;
}

// ---------------------------------------------------------------------------
// qualification builder
// ---------------------------------------------------------------------------

function buildQualification(
  co: CompanySpec,
  pk: ProductKey,
  isPrimary: boolean,
  target: Country,
): Omit<s.NewQualification, 'workspaceId' | 'sourceRecordId' | 'productProfileId'> {
  const methodRoll = rand();
  const method = methodRoll < 0.7 ? 'ai' : methodRoll < 0.9 ? 'rules' : 'rules_fallback';
  const model = method === 'ai' ? 'gemini-2.5-flash' : null;
  const kw = KEYWORDS[pk];
  const matched = kw.filter(() => rand() < 0.45).slice(0, 4);
  if (matched.length === 0) matched.push(must(kw[0], 'kw'));

  let isRelevant = true;
  let score = 70;
  let confidence = 75;
  let reason: string | null = null;
  let rejection: string | null = null;
  const disq: string[] = [];
  let geoStatus: 'no_gate' | 'match' | 'mismatch' | 'unverified' = 'match';
  let inferred: string | null = co.country;

  if (!isPrimary) {
    isRelevant = false;
    score = between(18, 44);
    confidence = between(55, 80);
    rejection = `Weak fit for ${PRODUCT_LABEL[pk]}: ${co.name} shows no ${pk === 'sealant' ? 'passive fire / penetration sealing' : pk === 'aerogel' ? 'industrial pipework insulation' : 'facade / envelope'} work.`;
  } else {
    switch (co.outcome) {
      case 'lead':
        score = between(74, 94);
        confidence = between(70, 92);
        reason = `${co.name} installs ${pk === 'sealant' ? 'passive fire protection' : pk === 'wool' ? 'facade and envelope insulation' : 'industrial insulation'} for ${co.blurb.split(/[.:]/)[0]?.toLowerCase() ?? 'relevant clients'}.`;
        break;
      case 'new':
        score = between(62, 82);
        confidence = between(62, 85);
        reason = `Likely fit: ${co.blurb.split('.')[0]}.`;
        break;
      case 'needs_review':
        score = between(48, 61);
        confidence = between(40, 58);
        reason = 'Borderline: some relevant work but core business is unclear from the website.';
        disq.push('low_evidence');
        break;
      case 'unverified':
        score = between(66, 80);
        confidence = between(50, 60);
        reason = 'Good product fit, but no location evidence on the page.';
        geoStatus = 'unverified';
        inferred = null;
        disq.push(`geo:unverified(target=${target})`);
        break;
      case 'reject':
        isRelevant = false;
        score = between(8, 34);
        confidence = between(75, 95);
        rejection = rejectionFor(co);
        disq.push(pick(['exclude_keyword:residential', 'retail_ecommerce', 'design_only', 'wrong_product_category']));
        break;
      case 'mismatch':
        isRelevant = false;
        score = between(65, 82);
        confidence = between(70, 88);
        geoStatus = 'mismatch';
        rejection = `outside target country: company located in ${COUNTRY_NAME[must(co.country, 'country')]} (${co.country}), recipe targets ${COUNTRY_NAME[target]} (${target})`;
        disq.push(`geo:mismatch(${co.country}≠${target})`);
        break;
      case 'ignored':
      case 'duplicate':
      case 'archived':
        score = between(52, 70);
        confidence = between(55, 75);
        reason = `Partial fit: ${co.blurb.split('.')[0]}.`;
        break;
    }
  }
  if (geoStatus === 'match' && co.country && co.country !== target) geoStatus = 'mismatch';

  const contributions =
    method === 'ai'
      ? [{ kind: 'ai_score', value: `${score}/100 (conf ${confidence})`, delta: score }]
      : [
          ...matched.map((k) => ({ kind: 'include_keyword', value: k, delta: 6 })),
          ...(isRelevant ? [{ kind: 'sector', value: pick(['Oil & gas', 'Data centres', 'Logistics', 'Healthcare', 'Petrochemical']), delta: 10 }] : []),
          ...(!isRelevant && co.outcome === 'reject' ? [{ kind: 'exclude_keyword', value: pick(['residential', 'DIY', 'styropian']), delta: -25 }] : []),
        ];

  return {
    isRelevant,
    relevanceScore: score,
    confidence,
    qualificationReason: isRelevant ? reason : null,
    rejectionReason: isRelevant ? null : rejection,
    matchedKeywords: isRelevant || isPrimary ? matched : [],
    disqualifyingSignals: disq,
    evidence: { contributions, matchedLessonIds: [] },
    method,
    model,
    targetCountry: target,
    inferredCountry: inferred,
    geoStatus,
  };
}

const KEYWORDS: Record<ProductKey, string[]> = {
  aerogel: ['aerogel', 'pipe insulation', 'CUI', 'cryogenic', 'thermal insulation', 'LNG', 'lagging', 'steam'],
  wool: ['wełna mineralna', 'fasada wentylowana', 'izolacja', 'płyty warstwowe', 'ściana ogniowa'],
  sealant: ['fire stopping', 'passive fire', 'penetration seal', 'intumescent', 'Brandschutz', 'Abschottung', 'antincendio'],
};

function rejectionFor(co: CompanySpec): string {
  const b = co.blurb.toLowerCase();
  if (/residential|domów|homeowner|privatkunden|jednorodzinnych|bloków/.test(b)) return 'Residential / homeowner market — not our customer.';
  if (/shop|online|diy/.test(b)) return 'Retailer / e-commerce, not an installer.';
  if (/planungsbüro|planning|beratung/.test(b)) return 'Design consultancy only — no installation work.';
  if (/stalowych|steel/.test(b)) return 'Steel fabricator — wrong product category.';
  if (/wdvs|fassaden/.test(b)) return 'Facade contractor in DE — wool product not offered in Germany yet.';
  return 'Not a fit for any active product.';
}

function inUsers(ids: string[]) {
  return inArray(s.users.id, ids);
}

function recipeSelectors(r: RecipeSpec): Record<string, unknown> {
  if (r.connector === 'web') {
    return { country: r.country, language: r.language, maxResults: 20, searchQueriesIssued: r.queries };
  }
  if (r.connector === 'directory') {
    return { country: r.country, language: r.language, item: '.listing-card', name: '.listing-card h3', website: 'a.website' };
  }
  return { country: r.country, language: r.language, cpv: ['45343000'] };
}

function recipePagination(r: RecipeSpec): Record<string, unknown> {
  return r.connector === 'directory' ? { nextSelector: 'a.next', maxPages: 5 } : { pages: 2 };
}

main()
  .then(async () => {
    await client.end();
  })
  .catch(async (err) => {
    console.error('seed-demo failed:', err);
    await client.end();
    process.exit(1);
  });
