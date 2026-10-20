# AutoATC controller applications

Human controllers for AutoATC events apply here. They sign in with Discord, which reads their roles and join date
in the servers you list (OAuth2 scope `guilds.members.read`, nothing else), and answer the interview questions
once: one application per Discord account. Reviewers (listed by Discord user id) read the applications at
`/apply/review`, where they set a status (new / interview / accepted / waitlist / rejected), add private notes, see
how many people want each position, or delete an application so that person can apply again.

Reviewers decide who controls where: each application has a position picker (one person per position), and the
Roster table shows every position, who has it and whether it was one of their picks. **Download CSV** exports every
application (Discord details, roles and join dates, answers, status, position, notes) for a spreadsheet. Nothing is
shown to applicants until a reviewer presses **Publish roster**; then accepted applicants with a position see it on
`/apply`, waitlisted ones are told they're on the waitlist, and everyone else that they don't have a position.

- Applicant page: `/apply/`
- Review page: `/apply/review`
- Questions and positions: `apply/config.js`

## Deploy on Railway

1. New service → deploy from this repo, branch `controller-applications`. Railway runs `npm start`.
2. Settings → Networking → **Generate domain**.
3. Add a **volume** (any mount path). Applications are saved there; without one they are lost on every redeploy,
   and the review page warns about it.
4. In the Discord Developer Portal, use or create an application. Under OAuth2 → Redirects add
   `https://<your domain>/apply/callback`.
5. Set the variables:

| Variable | What |
| --- | --- |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From that Discord application (OAuth2 page). |
| `APPLY_GUILDS` | The servers to read, e.g. `111…:AutoATC:required,222…:PTFS`. `required` means you must be a member to apply. |
| `APPLY_ADMIN_IDS` | Comma-separated Discord user ids of the reviewers. |
| `APPLY_SESSION_SECRET` | Any long random string (keeps people signed in across restarts). |
| `APPLY_BOT_TOKEN` | Optional. A bot that is in those servers, so role ids show as role names. |
| `APPLY_PUBLIC_URL` | Optional. The app's address, if it isn't the Railway domain (e.g. a custom domain). |
| `APPLY_OPEN` | `false` closes applications. |

## Run locally

`npm install`, then `npm start` (http://localhost:3000/apply/) and `npm test`. A `.env` file works for the
variables; add `http://localhost:3000/apply/callback` as a redirect in Discord to sign in locally.
