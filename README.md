# Tournament app v5 (Badminton • Carrom • Chess • Table Tennis — Adults & Kids)

Mobile web app for Android and iPhone. Runs on your Mac; everyone joins through a **public https link**
from any network. Free.

## Start it (Mac)
Open Terminal in this folder and run:

    ./start.command

(or double-click `start.command`). It installs what it needs, starts the app, creates the public link,
prints the link + a QR code, and prints the **Admin PIN** (shown only on first run – write it down).

- `./start.command --local`      Wi-Fi only, no public link
- `./start.command --reset-pin`  set a new admin PIN if you forget it

### Public link: which one?
| | Link | Setup |
|---|---|---|
| **Tailscale Funnel (recommended)** | Stable – never changes | One-time, free account (below) |
| Cloudflare quick tunnel (automatic fallback) | New link each start | None – installs itself via Homebrew |

**One-time Tailscale setup (stable link):**
1. Install the Tailscale app on the Mac (https://tailscale.com/download) and sign in (free personal plan).
2. In the Tailscale admin page (https://login.tailscale.com/admin/dns) turn on **MagicDNS** and **HTTPS Certificates**.
3. Run `./start.command` – if Funnel needs to be allowed, Tailscale prints a link; open it and click enable, then run the script again.

With Cloudflare, start the app once, share the link, and leave it running until the event is over.
The Mac must stay on, plugged in and online (the script keeps it awake).

**Easiest way to a permanent link:** run `./start-stable.command` – it installs what is missing, walks you through the Tailscale sign-in, and refuses to start if it cannot give you the permanent link. Add `--autostart` to have the app start by itself after every restart.

## Before the event (do a dry run!)
1. Start the app, open the public link on **two real phones** (one Android, one iPhone), on mobile data.
2. Admin → Setup: name, logo, signatories. Players, teams, referees, events.
3. Menu → Notifications → Turn on (iPhone: Share → Add to Home Screen first), then as admin tap **Send test**.
4. Score a practice match from a phone, switch the phone to airplane mode, tap a few points, switch back – they sync.

## Sections
Adults and Kids are separate: each has its own players, teams, events (Kids – Badminton / Table Tennis / Carrom / Chess),
standings, schedule and leaderboards. Players can only be enrolled in events of their own section.
Kids' photos are hidden from the public unless you enable them (Admin → Setup).

## Rules built in
- Women's doubles: after each finished game each side's score is split between the partners (15 → 7.5 each) and added to
  each player's tally. Ranked by tally, then point difference. Ties at the finals cut-off are flagged.
- Matches end automatically (best of 3 to 15 by default). Everything is editable per event.
- Only "League" fixtures count in standings. Admin can generate round-robin / rotating-partner doubles fixtures,
  create finals from the standings, correct scores, and see who changed what.

## 🔔 Notify players on WhatsApp

Every match that is still to be played shows a **🔔 Notify** button to organizers and referees (on the match card and on the match page).
It opens a ready-made message (game, match number, sides, court, time, referee, live-score link) that you can edit.
`{name}` becomes each player's first name, `{link}` the live-score link. In a team match every member of both teams is included.

* **Default (no setup):** tap **WhatsApp** next to each player. WhatsApp opens with the message ready, so press send there.
  **Send to a WhatsApp group** posts one message to a group instead.
  10-digit numbers get the country code `91`. To change it, set `PHONE_COUNTRY_CODE`.
* **Fully automatic (optional):** set up the WhatsApp Business Cloud API (Meta) and start the app with
  `WHATSAPP_TOKEN=… WHATSAPP_PHONE_ID=…`. A **Send to all** button then sends every message from the server.
  WhatsApp only allows messages a player did not start if they use an approved template. Set `WHATSAPP_TEMPLATE=<name>` (and `WHATSAPP_LANG`, default `en`).
  The template body gets `{{1}}` = first name, `{{2}}` = match line, `{{3}}` = link.

The match records who notified the players and when ("🔔 Notified 5 min ago"). Phone numbers are shown to staff only, and masked.

## Data & backup
Everything is in `data/` (db.json, uploads, auto-backups every 10 min; also copied to iCloud Drive > TournamentBackup if you use iCloud).
Admin → Data downloads a full backup (including photos) and can start a new tournament while keeping player profiles.

## Tests
`npm test`

## Player profiles (v2.1)
Every player now has a profile page (tap a name in **Players**, a leaderboard or a match):
- **Automatic:** record, win rate, tally, point difference, games W–L, recent form, win streaks, personal records (biggest win, highest game), honours (champion / runner-up), doubles partners, head-to-head, by-event table, full match history.
- **Entered by the admin** (Players → tap a player → Edit): player ID (auto, e.g. P007, stays the same every year), affiliation, playing hand, bio, level and style per sport (chess rating optional), past achievements, and private fields (phone, email, emergency contact, T-shirt size, notes).
- **Privacy:** name, age group, match stats are always public. The extended profile (bio, style, honours, history) has a "show publicly" switch: **on by default for adults, off for kids**. Private fields are never shown publicly or in the public Excel export.
- **Career history:** when you start a new tournament with *keep players*, each player's results are saved to "Past tournaments" on their profile.
- Players cannot edit their own profile (there are no player logins); the admin does it.

---
## What's new in v3

**Online registration** – Admin → Registration: switch it on, set a *join code* and optional deadline, edit the consent text. Players open the link (Menu shows a QR), enter the code and register; kids need a parent/guardian name and phone plus consent. **Every registration waits for your approval** (Approve / Approve all / Reject); approving enrolls them in the events they asked for (respecting each event's max-players limit). After registering, a player gets a private link to add a photo, style and details; they cannot change their section, events or scores.

**Safer by default** – named admins each with their own PIN (activity log shows who did what), "sign out all other devices", one-time Excel download links (your admin key never appears in a URL), rate limits on everything public, sign-in lockout that blocks only the guesser, encrypted backups, damaged-file recovery from the latest backup, children's photos in the gallery hidden unless you enable them, and a Privacy clean-up tool (Admin → Data) to erase contact details after the event.

**Match-day features** – walkovers, retirements and disqualifications ("End match early…"), withdraw/replace a player, a one-scorer-at-a-time lock (with "take over"), score-problem reports from spectators (Admin → Reports), Trash with 30-day restore, optional head-to-head tie-break, random draw, printable fixture list and referee score sheets (Menu → Fixture & score sheets), sponsor rotation, and "starting soon" notifications 15 minutes before a match (needs start times and the venue time zone in Setup).

**Always-on hosting** – see `deploy/DEPLOY.md` (free VM with automatic https). The Mac launcher still works and now encrypts its backup copies (the password is saved in `~/.tournament-backup-key` – keep a copy).

Load test (`npm run load`): 2,000 phones watching live while 8 referees scored – no errors, scoring responses under 20 ms, ~140 MB memory.

---
## What's new in v4 – you choose the format of every event

Admin → Events → tap an event → **Tournament format**:
- **Round robin** – everyone plays everyone; optional finals for the top N (2 = final, 4 = semi-finals + final, 8 = quarter-finals, any number works – top seeds get byes).
- **Groups → knockout** – choose number of groups and how many qualify per group. Groups are snake-seeded (enrolment order, or random). Group winners meet other groups' runners-up.
- **Knockout** – lose and you are out. Byes for the top seeds when the field is not a power of 2. Bracket tab shows every round.
- **Swiss** – fixed rounds (or automatic); similar scores meet, no repeat pairings, odd field gets a bye; ties broken by Buchholz. Ideal for chess.
- Options: third-place match, return matches in groups/league, and **automatic next round** (the next round / finals is created when the current one finishes).
- Event page buttons adapt: *Draw groups / Draw bracket / Next Swiss round*, *Next round / Create knockout*, and *Reset draw* (start over).
- Doubles keep rotating partners + tally ranking and a final between the top 4.

**Team events with rubbers** – in a team event, define the tie: e.g. *Men's singles, Women's singles, Mixed doubles* (singles/doubles, men/women/anyone, how many of each, optional own scoring rules). A tie is won by the team that wins most rubbers (optionally stops once clinched). Open a tie → **Set line-ups** (only a team's own members; gender rule and a per-player limit are enforced) → score each rubber like a normal match. Team standings rank by tie points, then rubbers won minus lost. Player profiles count the rubbers each player played.

**Also new:** *Running late?* (Admin → Events: shift every unfinished match by N minutes from a time, per event or court); age ranges per kids event (use **Duplicate** to make Under-8 / Under-10 / Under-12 copies; registration only offers events that fit the age); optional "referees may score only their own matches"; third-place certificates; uploads are checked to be real images; players can tap "Tell me when I am approved"; the Setup tab shows the link everyone uses and warns when it is temporary (it changes on every restart – use Tailscale Funnel for a permanent free link; the launcher now warns if the link changed).

Tests: `npm test` (30 tests, including formats end to end).

**House rule for Carrom, Table Tennis and Chess (Adults and Kids)** – these events are round robin. Fewer than 8 players: the top 2 play a straight final. 8 or more: the top 4 play semi-finals (1 v 4, 2 v 3) and then the final. The count uses players actually in the event (withdrawn players are not counted). It is set per event in Edit event → *Fewer players than… / then only top N qualify* (empty = rule off), and old data is migrated automatically. Use the event page's **Create finals** button (or switch on automatic next round). A drawn semi-final (e.g. chess) needs a winner: open it → *End match early…* to record the tie-break result.

## What's new in v5 – built from the agreed baseline

**Rules (international defaults, all editable per event, and per fixture)**
- Badminton: BWF – best of 3, 21 points, win by 2, cap 30 (kids default to 15 points).
- Table tennis: ITTF – best of 3, 11 points, win by 2. Chess: 1 / ½ / 0.
- Carrom: ICF – best of 3 games; a game is 25 points or 8 boards; 1 point per opponent coin left, queen 3, queen bonus lost once the scorer reaches the cutoff (22). Coin weight, queen weight, cutoff and boards per game are settings. The referee records a finished board with **Board won**.
- Round robin, then: fewer than 8 players → top 2 play a final; 8 or more → top 4 semi-finals then final. The player count is **frozen when the event's first match is played**.
- **Retirement / injury:** the opponent wins; their current game goes to the game target and unplayed games are recorded target–0 (chess 1–0). **Walkovers** are recorded by the referee after the organizer, referee and captains agree.

**Who can do what**
- Only **referees** change scores. The **chief referee** corrects or resets scores and resolves players' score reports. The organizer cannot edit scores. **Sport leads** manage one sport. **Volunteers** help with check-in only. **Captains** sign in with a team code and choose/shuffle their line-up until the tie starts; the opposing line-up stays hidden until both are set.
- **Cards:** everyone is green. Referees give a yellow (warning) or red card; a red means the player's next two scheduled games are lost as walkovers and they cannot be put in a line-up. The chief referee can revoke; the organizer can reset a record. Cards are never public.

**Fixtures** are made by the organizer with "Round x of y" and optional points settings for that match only. Late entries are allowed (add the player, then generate the extra fixtures).

**Registration & duplicates:** the join code can be changed instantly (🔄), accounts lock for 15 minutes after 5 wrong PINs. Possible duplicates are **flagged for the organizer** (siblings often share a phone); only an identical name + date of birth in the same event is refused. A **Merge** button combines two records.

**Notifications:** at registration the player is asked to turn on alerts (with an iPhone "Add to Home Screen" walk-through). **Admin → Reachability** shows who is On / Said no / Can't / Not set, sends a test to any player, and gives a message to share by WhatsApp or SMS. **Admin → Announce** sends a message to everyone (or one sport). Match starts, "up next" and results also appear on the **Updates** page.

**Event day (Admin → Event day):** freeze scoring, lock one event, or hide the public scoreboard (each needs a typed word); go back to a saved snapshot; import players from Excel with a preview. **Paper scores:** a referee can enter a match from a paper sheet (or upload the Excel template); it shows "from paper" until the chief referee signs it off.

**Privacy:** the public sees first names only (last initial when two share a first name) – no photos, ages, contact details, cards or staff names. Staff see full names, not contact details.

**Languages:** English, Tamil, Telugu, Hindi, Kannada, Malayalam (Menu → Language, also on the registration page). The Indian-language wording is a first draft – **have a native speaker per language read it** (`public/i18n.js`) before the event.

**Still needed from you:** team-event structure (teams, men/women split, rubbers), women's doubles finals format, logo, sponsor banners.
