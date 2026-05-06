import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@notionhq/client";
import { load as loadHtml } from "cheerio";

const REQUIRED_ENV_VARS = [
  "NOTION_TOKEN",
  "NOTION_COMPANIES_DB_ID",
  "NOTION_APPS_DB_ID",
  "DISCORD_WEBHOOK_URL"
];

const INTERNSHIP_KEYWORDS = ["intern", "internship", "co-op", "coop"];
const TECH_KEYWORDS = [
  "software",
  "swe",
  "engineer",
  "engineering",
  "developer",
  "frontend",
  "backend",
  "full stack",
  "fullstack",
  "data",
  "machine learning",
  "ml",
  "ai",
  "electrical",
  "eecs",
  "computer science",
  "embedded",
  "firmware",
  "systems"
];
const TITLE_SIMILARITY_THRESHOLD = 0.5;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const USER_AGENT =
  "internship-monitor/1.0 (+https://github.com; free-notion-discord-monitor)";
const DEBUG_ENDPOINT = "http://127.0.0.1:7684/ingest/74cc1cfb-b75f-4990-9811-1f44bafe5045";
const DEBUG_SESSION_ID = "e13dca";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.resolve(__dirname, "..", "seen_jobs.json");

function assertEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function normalizeText(value) {
  return (value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s/-]/g, "")
    .trim();
}

function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const param of [...parsed.searchParams.keys()]) {
      if (param.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(param);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return (url || "").trim();
  }
}

function tokenize(value) {
  return new Set(
    normalizeText(value)
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
  );
}

function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

async function fetchWithRetry(url, { timeoutMs = REQUEST_TIMEOUT_MS, retries = MAX_RETRIES } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/json"
        }
      });
      clearTimeout(timeout);
      if (!response.ok) {
        // #region agent log
        fetch(DEBUG_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e13dca" }, body: JSON.stringify({ sessionId: DEBUG_SESSION_ID, runId: process.env.GITHUB_RUN_ID || "local-run", hypothesisId: "H1", location: "src/index.js:116", message: "HTTP non-OK response", data: { url, status: response.status, attempt, retries }, timestamp: Date.now() }) }).catch(() => {});
        // #endregion
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      attempt += 1;
      // #region agent log
      fetch(DEBUG_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e13dca" }, body: JSON.stringify({ sessionId: DEBUG_SESSION_ID, runId: process.env.GITHUB_RUN_ID || "local-run", hypothesisId: "H2", location: "src/index.js:124", message: "Fetch attempt failed", data: { url, attempt, retries, errorName: error?.name || "UnknownError", errorMessage: String(error?.message || error), aborted: error?.name === "AbortError" }, timestamp: Date.now() }) }).catch(() => {});
      // #endregion
      if (attempt > retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw new Error("Unexpected retry exit");
}

function getTitleProperty(properties) {
  const prop = Object.values(properties).find((entry) => entry?.type === "title");
  if (!prop) return "";
  return (prop.title || []).map((item) => item.plain_text || "").join("").trim();
}

function getRichText(properties, candidates) {
  for (const candidate of candidates) {
    const match = Object.entries(properties).find(([name]) =>
      name.toLowerCase().includes(candidate)
    );
    if (!match) continue;
    const [, prop] = match;
    if (prop.type === "url") return prop.url || "";
    if (prop.type === "rich_text") {
      return (prop.rich_text || []).map((item) => item.plain_text || "").join("").trim();
    }
  }
  return "";
}

async function queryAllRows(notion, databaseId) {
  let cursor = undefined;
  const rows = [];
  do {
    const result = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor
    });
    rows.push(...result.results);
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function loadCompanies(notion) {
  const rows = await queryAllRows(notion, process.env.NOTION_COMPANIES_DB_ID);
  return rows
    .map((row) => {
      const company = getTitleProperty(row.properties);
      const careersUrl =
        getRichText(row.properties, ["career", "jobs", "url", "link"]) ||
        Object.values(row.properties).find((p) => p.type === "url")?.url ||
        "";
      return { company, careersUrl };
    })
    .filter((item) => item.company && item.careersUrl);
}

function applicationEntryFromRow(row) {
  const title = getTitleProperty(row.properties) || getRichText(row.properties, ["role", "position", "title"]);
  const company = getRichText(row.properties, ["company"]);
  const jobUrl = getRichText(row.properties, ["job", "posting", "url", "link"]);
  return {
    normalizedTitle: normalizeText(title),
    normalizedCompany: normalizeText(company),
    canonicalUrl: jobUrl ? canonicalizeUrl(jobUrl) : "",
    titleTokens: tokenize(title)
  };
}

function buildApplicationsIndex(rows) {
  const byUrl = new Set();
  const byCompanyAndTitle = new Set();
  const entries = [];

  for (const row of rows) {
    const entry = applicationEntryFromRow(row);
    if (entry.canonicalUrl) byUrl.add(entry.canonicalUrl);
    if (entry.normalizedCompany && entry.normalizedTitle) {
      byCompanyAndTitle.add(`${entry.normalizedCompany}|${entry.normalizedTitle}`);
    }
    entries.push(entry);
  }

  return { byUrl, byCompanyAndTitle, entries };
}

async function loadApplicationsIndex(notion) {
  const rows = await queryAllRows(notion, process.env.NOTION_APPS_DB_ID);
  return buildApplicationsIndex(rows);
}

function containsInternKeyword(text) {
  const lower = (text || "").toLowerCase();
  return INTERNSHIP_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function containsTechKeyword(text) {
  const lower = (text || "").toLowerCase();
  return TECH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function isTargetRoleTitle(text) {
  return containsInternKeyword(text) && containsTechKeyword(text);
}

function roleKey(role) {
  return `${normalizeText(role.company)}|${normalizeText(role.title)}|${canonicalizeUrl(role.url)}`;
}

function isLikelyAppliedRole(role, applicationsIndex) {
  const roleUrl = canonicalizeUrl(role.url);
  const roleCompany = normalizeText(role.company);
  const roleTitle = normalizeText(role.title);
  if (applicationsIndex.byUrl.has(roleUrl)) return true;
  if (applicationsIndex.byCompanyAndTitle.has(`${roleCompany}|${roleTitle}`)) return true;

  const roleTokens = tokenize(role.title);
  for (const entry of applicationsIndex.entries) {
    if (!entry.normalizedCompany || entry.normalizedCompany !== roleCompany) continue;
    if (jaccardSimilarity(roleTokens, entry.titleTokens) >= TITLE_SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

function extractCandidateRoles(company, careersUrl, html) {
  const $ = loadHtml(html);
  const results = [];
  $("a").each((_, element) => {
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href");
    if (!title || !href) return;
    if (!isTargetRoleTitle(title)) return;
    const absolute = new URL(href, careersUrl).toString();
    results.push({ company, title, url: absolute });
  });
  return results;
}

async function scrapeCompanyJobs(company) {
  try {
    // #region agent log
    fetch(DEBUG_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e13dca" }, body: JSON.stringify({ sessionId: DEBUG_SESSION_ID, runId: process.env.GITHUB_RUN_ID || "local-run", hypothesisId: "H3", location: "src/index.js:268", message: "Starting company scrape", data: { company: company.company, careersUrl: company.careersUrl }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    const response = await fetchWithRetry(company.careersUrl);
    const html = await response.text();
    return {
      company: company.company,
      roles: extractCandidateRoles(company.company, company.careersUrl, html),
      error: null
    };
  } catch (error) {
    // #region agent log
    fetch(DEBUG_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e13dca" }, body: JSON.stringify({ sessionId: DEBUG_SESSION_ID, runId: process.env.GITHUB_RUN_ID || "local-run", hypothesisId: "H4", location: "src/index.js:279", message: "Company scrape failed", data: { company: company.company, careersUrl: company.careersUrl, errorName: error?.name || "UnknownError", errorMessage: String(error?.message || error) }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    return {
      company: company.company,
      roles: [],
      error: String(error?.message || error)
    };
  }
}

function summarizeScrapeResults(scrapeResults) {
  const totalCompanies = scrapeResults.length;
  const failed = scrapeResults
    .filter((item) => item.error)
    .map((item) => ({ company: item.company, reason: item.error }));
  const failedCompanies = failed.length;
  const successfulCompanies = totalCompanies - failedCompanies;
  return { totalCompanies, successfulCompanies, failedCompanies, failed };
}

async function loadSeenState() {
  try {
    const raw = await fs.readFile(STATE_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.seenKeys) ? parsed.seenKeys : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function saveSeenState(seenSet) {
  const payload = {
    updatedAt: new Date().toISOString(),
    seenKeys: [...seenSet].sort()
  };
  await fs.writeFile(STATE_FILE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function trimLines(lines, maxChars = 1900) {
  const kept = [];
  let total = 0;
  for (const line of lines) {
    const nextLength = line.length + 1;
    if (total + nextLength > maxChars) break;
    kept.push(line);
    total += nextLength;
  }
  return kept;
}

function buildRunSummary(newRolesCount, scrapeSummary) {
  return [
    "Run summary:",
    `- New roles: ${newRolesCount}`,
    `- Scrape success: ${scrapeSummary.successfulCompanies}/${scrapeSummary.totalCompanies}`,
    `- Scrape failures: ${scrapeSummary.failedCompanies}`
  ];
}

function formatFailureLines(scrapeSummary) {
  if (scrapeSummary.failed.length === 0) return [];
  const lines = ["", "Failed scrapes:"];
  for (const entry of scrapeSummary.failed) {
    lines.push(`- ${entry.company} -> ${entry.reason}`);
  }
  return lines;
}

function formatDiscordLines(roles, scrapeSummary) {
  const lines = [...buildRunSummary(roles.length, scrapeSummary)];
  if (roles.length === 0) {
    return [...lines, "", "No new target internships found this run.", ...formatFailureLines(scrapeSummary)];
  }

  lines.push("", "New target internships found:");
  const byCompany = roles.reduce((acc, role) => {
    if (!acc[role.company]) acc[role.company] = [];
    acc[role.company].push(role);
    return acc;
  }, {});

  for (const [company, companyRoles] of Object.entries(byCompany)) {
    lines.push(`**${company}**`);
    for (const role of companyRoles) {
      lines.push(`- ${role.title} -> ${role.url}`);
    }
  }
  return [...lines, ...formatFailureLines(scrapeSummary)];
}

async function sendDiscordNotification(newRoles, scrapeSummary) {
  const lines = formatDiscordLines(newRoles, scrapeSummary);
  const body = { content: trimLines(lines).join("\n") };
  const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Discord webhook failed with ${response.status}`);
}

async function run() {
  assertEnv();
  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  console.log("Loading companies and applications from Notion...");
  const [companies, applicationsIndex, seenKeys] = await Promise.all([
    loadCompanies(notion),
    loadApplicationsIndex(notion),
    loadSeenState()
  ]);
  console.log(`Loaded ${companies.length} companies.`);
  console.log(
    `Loaded ${applicationsIndex.entries.length} applications, ${applicationsIndex.byUrl.size} app URLs, and ${seenKeys.size} seen keys.`
  );

  const scrapeResults = [];
  for (const batch of chunk(companies, 4)) {
    const resultBatch = await Promise.all(batch.map((company) => scrapeCompanyJobs(company)));
    scrapeResults.push(...resultBatch);
  }

  const scrapeSummary = summarizeScrapeResults(scrapeResults);
  const scrapedRoles = scrapeResults.flatMap((item) => item.roles);
  console.log(`Scraped ${scrapedRoles.length} internship + tech link candidates.`);
  if (scrapeSummary.failed.length > 0) {
    for (const entry of scrapeSummary.failed) {
      console.warn(`Warning scraping ${entry.company}: ${entry.reason}`);
    }
  }
  console.log(`Scrape success ratio: ${scrapeSummary.successfulCompanies}/${scrapeSummary.totalCompanies}`);

  const unique = new Map();
  for (const role of scrapedRoles) unique.set(roleKey(role), role);
  const dedupedRoles = [...unique.entries()].map(([key, role]) => ({ ...role, key }));

  const trulyNew = dedupedRoles.filter((role) => {
    return !isLikelyAppliedRole(role, applicationsIndex) && !seenKeys.has(role.key);
  });

  for (const role of dedupedRoles) seenKeys.add(role.key);
  await saveSeenState(seenKeys);

  await sendDiscordNotification(trulyNew, scrapeSummary);
  if (trulyNew.length > 0) {
    console.log(`Sent Discord alert for ${trulyNew.length} new roles.`);
  } else {
    console.log("No new roles found this run; sent summary to Discord.");
  }
}

run().catch((error) => {
  console.error("Internship monitor failed:", error);
  process.exit(1);
});
