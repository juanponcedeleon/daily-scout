# Free Internship Monitor

Twice a day, this project:
- reads companies/careers URLs from Notion
- scrapes careers pages for internship + SWE/engineering/tech/EECS-adjacent roles
- removes roles already applied to in Notion (URL-first matching + tolerant same-company title matching)
- removes previously seen roles
- sends only new matches to Discord
- always includes scrape reliability in notification (`successful/total`) plus failed-company reasons
- drops roles only when link/context text clearly indicates a non-US location; if location is missing or unclear, the role is kept
