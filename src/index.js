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

const KEYWORDS = ["intern", "internship", "co-op", "coop"];
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const USER_AGENT =
  "internship-monitor/1.0 (+https://github.com; free-notion-discord-monitor)";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.resolve(__dirname, "..", "seen_jobs.json");
const DEBUG_INGEST_ENDPOINT = "http://127.0.0.1:7684/ingest/74cc1cfb-b75f-4990-9811-1f44bafe5045";
const DEBUG_SESSION_ID = "e13dca";
const DEBUG_RUN_ID = process.env.GITHUB_RUN_ID || "local-run";

function debugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  fetch(DEBUG_INGEST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      attempt += 1;
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
  const companies = rows
    .map((row) => {
      const company = getTitleProperty(row.properties);
      const careersUrl =
        getRichText(row.properties, ["career", "jobs", "url", "link"]) ||
        Object.values(row.properties).find((p) => p.type === "url")?.url ||
        "";
      return { company, careersUrl };
    })
    .filter((item) => item.company && item.careersUrl);
  return companies;
}

function applicationKeysFromRow(row) {
  const title = getTitleProperty(row.properties) || getRichText(row.properties, ["role", "position", "title"]);
  const company = getRichText(row.properties, ["company"]);
  const jobUrl = getRichText(row.properties, ["job", "posting", "url", "link"]);
  const keys = new Set();
  const normalizedTitle = normalizeText(title);
  const normalizedCompany = normalizeText(company);
  if (normalizedTitle && normalizedCompany) keys.add(`${normalizedCompany}|${normalizedTitle}`);
  if (jobUrl) keys.add(canonicalizeUrl(jobUrl));
  return keys;
}

async function loadApplicationKeys(notion) {
  const rows = await queryAllRows(notion, process.env.NOTION_APPS_DB_ID);
  const applied = new Set();
  for (const row of rows) {
    for (const key of applicationKeysFromRow(row)) applied.add(key);
  }
  return applied;
}

function containsInternKeyword(text) {
  const lower = (text || "").toLowerCase();
  return KEYWORDS.some((keyword) => lower.includes(keyword));
}

function roleKey(role) {
  return `${normalizeText(role.company)}|${normalizeText(role.title)}|${canonicalizeUrl(role.url)}`;
}

function extractCandidateRoles(company, careersUrl, html) {
  const $ = loadHtml(html);
  const results = [];
  $("a").each((_, element) => {
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href");
    if (!title || !href) return;
    if (!containsInternKeyword(title)) return;
    const absolute = new URL(href, careersUrl).toString();
    results.push({ company, title, url: absolute });
  });
  return results;
}

async function scrapeCompanyJobs(company) {
  try {
    const response = await fetchWithRetry(company.careersUrl);
    const html = await response.text();
    return {
      company: company.company,
      roles: extractCandidateRoles(company.company, company.careersUrl, html),
      error: null
    };
  } catch (error) {
    return {
      company: company.company,
      roles: [],
      error: String(error?.message || error)
    };
  }
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

function formatDiscordLines(roles) {
  const byCompany = roles.reduce((acc, role) => {
    if (!acc[role.company]) acc[role.company] = [];
    acc[role.company].push(role);
    return acc;
  }, {});

  const lines = ["New internship postings found:"];
  for (const [company, companyRoles] of Object.entries(byCompany)) {
    lines.push(`**${company}**`);
    for (const role of companyRoles) {
      lines.push(`- ${role.title} -> ${role.url}`);
    }
  }
  return lines;
}

async function sendDiscordNotification(newRoles, errors) {
  const lines = formatDiscordLines(newRoles);
  if (errors.length > 0) {
    lines.push("");
    lines.push(`Scrape errors (${errors.length}): ${errors.map((e) => e.company).join(", ")}`);
  }
  const body = { content: lines.join("\n").slice(0, 1900) };
  const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Discord webhook failed with ${response.status}`);
}

async function run() {
  debugLog("H1", "src/index.js:273", "Monitor run entered", { nodeVersion: process.version });
  assertEnv();
  debugLog("H2", "src/index.js:275", "Environment validation passed", {
    hasNotionToken: Boolean(process.env.NOTION_TOKEN),
    hasCompaniesDb: Boolean(process.env.NOTION_COMPANIES_DB_ID),
    hasAppsDb: Boolean(process.env.NOTION_APPS_DB_ID),
    hasDiscordWebhook: Boolean(process.env.DISCORD_WEBHOOK_URL)
  });
  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  console.log("Loading companies and applications from Notion...");
  const [companies, appliedKeys, seenKeys] = await Promise.all([
    loadCompanies(notion),
    loadApplicationKeys(notion),
    loadSeenState()
  ]);
  debugLog("H3", "src/index.js:288", "Loaded Notion and state payload sizes", {
    companiesCount: companies.length,
    appliedKeysCount: appliedKeys.size,
    seenKeysCount: seenKeys.size
  });
  console.log(`Loaded ${companies.length} companies.`);
  console.log(`Loaded ${appliedKeys.size} application keys and ${seenKeys.size} seen keys.`);

  const scrapeResults = [];
  for (const batch of chunk(companies, 4)) {
    const resultBatch = await Promise.all(batch.map((company) => scrapeCompanyJobs(company)));
    scrapeResults.push(...resultBatch);
  }

  const errors = scrapeResults.filter((item) => item.error).map((item) => ({ company: item.company, error: item.error }));
  const scrapedRoles = scrapeResults.flatMap((item) => item.roles);
  console.log(`Scraped ${scrapedRoles.length} internship-like link candidates.`);
  if (errors.length > 0) {
    for (const entry of errors) console.warn(`Warning scraping ${entry.company}: ${entry.error}`);
  }

  const unique = new Map();
  for (const role of scrapedRoles) unique.set(roleKey(role), role);
  const dedupedRoles = [...unique.entries()].map(([key, role]) => ({ ...role, key }));

  const trulyNew = dedupedRoles.filter((role) => {
    const byUrl = canonicalizeUrl(role.url);
    const byCompanyAndTitle = `${normalizeText(role.company)}|${normalizeText(role.title)}`;
    return !appliedKeys.has(byUrl) && !appliedKeys.has(byCompanyAndTitle) && !seenKeys.has(role.key);
  });

  for (const role of dedupedRoles) seenKeys.add(role.key);
  await saveSeenState(seenKeys);

  if (trulyNew.length > 0) {
    debugLog("H4", "src/index.js:322", "Preparing Discord alert for new roles", {
      newRolesCount: trulyNew.length,
      scrapeErrorCount: errors.length
    });
    await sendDiscordNotification(trulyNew, errors);
    console.log(`Sent Discord alert for ${trulyNew.length} new roles.`);
  } else {
    console.log("No new roles found this run.");
    if (errors.length > 0) {
      await sendDiscordNotification([], errors);
      console.log("Sent scrape error summary to Discord.");
    }
  }
}

run().catch((error) => {
  debugLog("H5", "src/index.js:336", "Monitor run failed", {
    errorMessage: String(error?.message || error),
    errorName: error?.name || "UnknownError"
  });
  console.error("Internship monitor failed:", error);
  process.exit(1);
});
