# Free Internship Monitor

Twice a day, this project:
- reads companies/careers URLs from Notion
- scrapes careers pages for internship-like roles
- removes roles already applied to in Notion
- removes previously seen roles
- sends only new matches to Discord

## 1) Your Notion Database IDs

From your links:
- Companies URL: `https://www.notion.so/352468f5c2498090ac6fe3971436e3fb?v=352468f5c24980468486000c36caabd7`
- Applications URL: `https://www.notion.so/351468f5c2498012a554ee78c3ceba1b?v=351468f5c249801b8a1c000cc58b66d2`

Database IDs for secrets:
- `NOTION_COMPANIES_DB_ID=352468f5c2498090ac6fe3971436e3fb`
- `NOTION_APPS_DB_ID=351468f5c2498012a554ee78c3ceba1b`

## 2) Create Notion Integration

1. In Notion, create an internal integration and copy the token.
2. Share both databases with that integration.
3. Save token as `NOTION_TOKEN` in GitHub repo secrets.

## 3) Create Discord Webhook

1. In your Discord server/channel settings, create an incoming webhook.
2. Copy webhook URL.
3. Save as `DISCORD_WEBHOOK_URL` in GitHub repo secrets.

## 4) Required GitHub Secrets

In your private GitHub repository: `Settings -> Secrets and variables -> Actions`:
- `NOTION_TOKEN`
- `NOTION_COMPANIES_DB_ID`
- `NOTION_APPS_DB_ID`
- `DISCORD_WEBHOOK_URL`

## 5) Expected Notion Properties

The script is flexible, but works best if:

### Companies DB
- title property = company name
- URL/rich text property containing careers page URL
- property names can include words like `career`, `jobs`, `url`, or `link`

### Applications DB
- title or rich text with role title
- optional company property (contains `company` in name)
- optional role URL property (contains `job`, `posting`, `url`, or `link`)

## 6) Run locally (optional)

```bash
npm install
npm start
```

## 7) GitHub Actions Schedule

Workflow: `.github/workflows/internship-monitor.yml`
- Morning run: `0 15 * * *`
- Evening run: `0 2 * * *`
- Manual test run: `workflow_dispatch`

Adjust cron as needed for daylight savings/timezone changes.
