# BuzzIn

A trivia board for a night with friends. The laptop runs the game and is shown on the TV; everyone buzzes in from their phone. Run it on your laptop over home wifi (no internet needed), or play online from Render.

## Setup (once)

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
```

## Start a game

```bash
npm start
```

It prints something like:

```
  Open the host page on this laptop: http://localhost:3000/host
  Laptop's wifi IP: 192.168.1.20  (phones join at http://192.168.1.20:3000/join/CODE)
```

1. Open the host page on the laptop and share that window to the TV. Turn the TV or laptop volume up for the buzz, correct and wrong sounds (the 🔊 button at the top mutes them).
2. Click **Start a new game** (later: **⋯ → New game** in the top bar), pick a theme card, and click **▶ Start**. Friends scan the QR code (or type the link): the join page says which game they're joining, then they enter their name. **❓ How to play** (on the setup screen and the board) explains the rules in one screen; **📺 Show on TV** makes it big for everyone.
   - **Customise** (optional, remembered for next time): play both boards, Board 1 only or Board 2 only; Sparkle Round off or every 3, 4 or 6 questions; which Sparkle modes; bonuses on or off; the hidden Double on or off; and which 5 categories each board uses.
3. Click **Make random teams** (2–4 teams). Team names fit the theme (Desi Night: Team Mogambo, Team Basanti…; TV & Movies: Team Popcorn, Team Remote…), and the theme details show them before you start. Use **Reshuffle** or the dropdowns to move people around. Players who join after that wait in the lobby: the top bar shows **Lobby / teams (1 waiting)**, and you pick their team there. The board and question screens show the join link and room code in the top bar, and phones show each player's name, team and score.
4. Click **Go to the board →** and play:
   - Click a tile, read the question, then **Open buzzers**. The **💬 How to play** line under the category says what players should answer (hover a category on the board, or open Customise, to see it before picking). The buzz order shows on screen.
   - **✓ Correct** and **✕ Wrong** work once someone has buzzed. **Correct** adds the points and shows the answer big on the TV (with any "💡 Did you know?" fun fact), then **Next: bonus →** shows that team a **bonus challenge**: tap **Bonus done +50** or **Skip bonus**. **Wrong** takes the points away, locks that team out, and passes the turn to the next team in line.
   - **😂 +5** buttons (one per team) reward funny wrong answers. Tap as often as you like.
   - **Show answer** shows the answer (and fun fact) the same way, then **Back to board →**. **Back to board** on the question skips it without showing the answer. Used tiles go grey.
   - Fix any mistakes with the **− / +** buttons under each team's score.
   - **👁 Hold to peek** shows the answer while you hold it. If the TV mirrors your screen, it shows there too.
   - **Board 2 is worth double** (200–1000). When Board 1 is finished, tap **Play Board 2 (Double!)**. Scores carry over. **Board 2 →** at the top jumps early if you're short on time.
   - **Hidden Double:** one tile per board (never a 100/200) is secretly a Double. It flashes "DOUBLE!" and is worth 2× if right, −2× if wrong.
   - The first Double, bonus and Sparkle Round of a game each get a one-line explainer on screen.
   - **🏁 Finish game** (or **See the winner** when every board is done) shows the winner screen.
5. **✨ Sparkle Round** starts by itself after every 6 finished questions (answered correctly, or answer shown). You can also open it with the **✨ Sparkle Round** button on the board, or leave it with **Skip Sparkle**.
   - Pick the team, then the mode: 🎨 **Draw**, 🤐 **Dumb Charades** or 🎭 **Mimic**. For Draw, the team also picks a difficulty: 🌶️ Easy (50), 🌶️🌶️ Medium (100) or 🌶️🌶️🌶️ Tricky (200). The team chooses its performer, and you tap their name to draw a card. **Skip card** draws another.
   - Draw / Dumb Charades: the secret word or movie shows only on the performer's phone. Draw on paper or a whiteboard. For Draw, the TV shows the difficulty and points, and **🎉 Guessed!** adds them automatically.
   - Mimic: the prompt shows on the TV.
   - Tap **▶ Start timer** when the performer is ready (60 seconds). **⏸ Stop timer** pauses it.
   - Give **+25 / +50 / +100**, any amount in the box, or **No points**. Then you're back on the board.

## 📱 Use your phone as the remote

The host page is also what's on the TV, so everyone can see the buttons and "Hold to peek". With a remote you run the game from your phone, and the TV shows only the show: the question, the buzz order, the answer once you reveal it, and the scores. It's optional: without it, everything works as above.

1. On the TV, tap **📱 Use phone as remote** (in the lobby or the **⋯** menu).
2. Scan the QR with **your** phone. The code works once and expires in 2 minutes.
3. Click **Allow** on the TV. Nothing is controlled until you do, so if someone else scanned it first, click **Deny**.

Your phone now shows the answer and fun fact, the buttons, the Sparkle secret word and the scores with − / +. Keep it to yourself. Up to 2 phones can be remotes (for a co-host). If your phone dies, tap **Show controls** in the TV's corner. **⋯ → Disconnect remote(s)** on the TV logs every remote out at once, and the TV gets its buttons back. Starting a new game does the same.

## ✨ Make your own (any topic, made with Claude)

1. Click **New game**, then the **✨ Make your own** card.
2. Type a **topic** (like "90s cartoons" or "our office"), pick where the **players are from** (🌍 Mixed US + India, 🇺🇸 USA or 🇮🇳 India, so the questions use the right references), the **tone** (😂 Silly, 🙂 Mixed or 🤓 Nerdy), **1 or 2 boards**, whether you want a **Sparkle deck**, and the **reply format**:
   - **📊 Table (Excel / Sheets)**, recommended: Claude replies with one row per question. You can review and edit it in a spreadsheet, and if Claude stops halfway you can ask it to continue.
   - **{ } JSON**: the raw pack format.
3. Click **📋 Copy prompt** and paste it into Claude (claude.ai).
4. Copy Claude's **whole reply** into the **Paste pack here** box.
   - **Claude stopped halfway (Table)?** Type "continue" in Claude and paste that reply underneath the first one. Repeated header rows are fine.
   - **Want to review it first (Table)?** Paste the table into Excel or Google Sheets, fix anything, then select all the cells, copy, and paste them into the box. Or save as **CSV** and use **📂 Upload .csv / .json**. (.xlsx files aren't read directly: save as CSV first.)
5. Click **✔ Check pack**. If something's wrong, you'll see a list like `"Saturday Morning" → "Theme Tunes" has 4 questions, needs 5`. Fix it, or copy those lines back to Claude.
6. Read the **⚠️ Check these** list: facts Claude wasn't sure of (🔍 verify).
7. Keep a copy with **⬇ Download for Excel (.csv)** or **⬇ Download pack (.json)**. Either file can be uploaded next time. Then **▶ Start game with this pack**.

**Table columns:** `Board, Category, Points, Question, Answer, Bonus, Fun fact, Verify, How to play` (How to play only needs filling on a category's first row). An optional first row `Pack, <name>, <emoji>` sets the pack's name; otherwise the topic is used. Up to 4 rows `Team, <team name>` set the team names (Claude adds them; without them the teams are Team Red, Yellow, Green and Pink). Sparkle cards are rows like `Sparkle, Draw easy, , <thing>` (also `Draw medium`, `Draw tricky`, `Charades`, `Mimic`). Board 1 uses 100–500 points and Board 2 uses 200–1000.

An uploaded pack lives only in that game's memory and is gone when the server restarts, so keep the downloaded file. It must follow the strict rules: exactly 5 categories per board, and questions up to 300 characters.

## Play online (Render)

Hosted on Render, the game has a public https link, so phones can join on any network, mobile data included.

**One-time setup**
1. Put this folder in a GitHub repository (a private one is fine).
2. Sign up at [render.com](https://render.com) with your GitHub account.
3. In Render, click **New → Blueprint**, pick the repository and click **Apply**. Render reads `render.yaml` and creates a free web service.
4. When the deploy finishes, open `https://<your-service>.onrender.com/host`. The QR code and join link use that address automatically.

**Your own domain (the main address is www.buzzin-game.com)**
1. In Render, open the service → **Settings** → **Custom Domains**, add `www.buzzin-game.com` and `buzzin-game.com`, and set the DNS records Render shows at your domain registrar. Wait until Render shows both as verified (with a certificate). Render itself redirects `buzzin-game.com` → `www.buzzin-game.com`.
2. Then in **Environment**, add:
   - `PUBLIC_URL` = `https://www.buzzin-game.com`. QR codes, join links and the phone-remote pairing link use it. Without it, they use whatever address the host page was opened on.
   - `ALLOWED_ORIGINS` = `https://buzzin-game.com,https://www.buzzin-game.com,https://kuch-kuch-pata-hai.onrender.com`. These are the addresses `/admin` accepts changes from. `PUBLIC_URL` is always allowed. Without the list, `/admin` accepts only the address it was opened on.
3. Once `PUBLIC_URL` is set, the `onrender.com` address, `buzzin-game.com` (if a request reaches the app) and anything else in `ALLOWED_ORIGINS` redirect to `https://www.buzzin-game.com` with a 301 (same path). `PUBLIC_URL`'s own address is never redirected, so the app can't loop with Render's redirect. `/healthz` never redirects, so health checks work on every address. Set `PUBLIC_URL` only after step 1 works, or the `onrender.com` address will redirect to a domain that doesn't answer yet.

**Health check:** `GET /healthz` answers `ok`. It doesn't touch the database or games, and isn't rate-limited or logged. `render.yaml` uses it as Render's health check.

**Updating questions:** edit the JSON files, commit and push. Render redeploys by itself in a minute or two.

**Things to know about the free plan**
- It **sleeps after about 15 minutes with no visitors**. Open the host page a minute before people arrive, because the first load can take 30–60 seconds.
- The game lives in memory, so a redeploy or restart ends the current game and clears any uploaded "Make your own" pack. Don't push changes mid-game.
- Anyone with the link could open the host page and start their own game. Your game's room code keeps theirs separate.

**Keeping the public link safe**
- Only the laptop that clicked **New game** can run that game. It keeps a secret key, so seeing the room code on the TV isn't enough to take over.
- **Optional host PIN:** in Render, open the service → **Environment** → **Add Environment Variable**, set `HOST_PIN` to a number you choose, and save. After that, `/host` asks for the PIN before starting a game. Leave it unset for no PIN.
- Built-in limits: at most 20 games at once, 30 players per game, 5 new games per network every 10 minutes, 10 "Make your own" pack checks per game every 10 minutes, and games idle for 3 hours are deleted.
- Every pasted or uploaded pack is treated as untrusted: it's checked again on the server when the game starts, and its text is always shown as plain text.

## 🌐 Community boards: database setup (optional)

Community boards need a free Postgres database from [Neon](https://neon.tech). Without one, the game works exactly as before and the community features stay hidden.

**Create the database (once)**
1. Sign up at neon.tech and create a project (the Free plan is enough). It comes with a `main` branch: that's the live database.
2. Create a second branch for testing on your laptop: **Branches → Create branch**, e.g. `dev`.
3. For each branch, click **Connect** and copy the connection string. It looks like `postgresql://user:password@ep-….neon.tech/neondb?sslmode=require`. Treat it like a password.

**Live site (Render)**
- In Render, open the service → **Environment**, add `DATABASE_URL` with the **main** branch's connection string, and add `ADMIN_PIN` with a long PIN of your own (for the `/admin` review page). Save; Render redeploys.

**Your laptop**
- Copy `.env.example` to `.env` (git ignores it) and set `DATABASE_URL` to the **dev** branch's connection string, plus an `ADMIN_PIN`. Then `npm start`.

The tables are created by themselves when the server starts (`schema.sql`), along with 13 starting tags (Movies, TV, Music, …, 📚 Education). Each starting tag is added once, including to an existing database when a new one joins the list. Tags you later rename or delete in `/admin` stay that way. The server log says `Community boards: database connected.` when it's working. If it can't reach the database, it logs the reason and carries on without community boards.

## 🌐 Community boards: sharing and review (`/admin`)

Anyone with the site link can submit a board, and every board is reviewed before anyone else can see it (yours too).

**Log in:** open `/admin` (e.g. `https://<your-site>/admin`) and enter your `ADMIN_PIN`. You stay logged in for 12 hours on that browser. After 5 wrong PINs, that network has to wait 15 minutes.

**How people share:** in **✨ Make your own**, after **Check pack**, they open **🌐 Share with community**, optionally add a "Made by" name, tick 1–3 tags, and click **Submit for review**. Each network can submit 5 boards a day (failed submits don't count), and the queue holds at most 100 waiting boards.

**Review queue** (oldest first; at most 100 waiting)
- Each board shows when it was submitted and a full preview: every category with its how-to-play line, every question with its answer, bonus and fun fact, and the Sparkle deck. Questions Claude wasn't sure of are marked ⚠️ and highlighted: check those facts.
- **⚠️ HTML tags were removed** means the board had text like `<b>…</b>`. The tags are stripped when it's shared (and again whenever it's played); check the text still reads right.
- Fix the tags, "Made by" and kid-friendly if needed.
- If Claude suggested a new tag, **Link to existing tag**, **Create as new tag** (it's added to the tag list and to the next Make your own prompt), or **Ignore** it.
- **Approve** (needs at least 1 tag) or **Reject** (with an optional note for yourself).

**Approved:** every approved board with its tags and play count. **Edit** changes tags, "Made by" and kid-friendly; **Archive** hides a board from Community (and **Unarchive** brings it back).

**⭐ Add categories to Featured:** on a board in the Review queue, open **⭐ Add categories to Featured**, tick categories, pick a Featured theme and board (it shows how many slots are free; full boards can't be picked) and click **Add to Featured**. Each one is copied onto that board with its points (100–500 or 200–1000, by question order) and shows in that theme's Customise as an optional category, off by default. A board holds at most 8 categories. The shared board itself stays in the queue: approve it, reject it or leave it. The **⭐ Featured extras** tab lists them; **Remove** takes one off again. (They're kept in the database, so without one the Featured themes are just their files.)

**Tags:** add a tag, rename it or change its emoji, **Merge** one tag into another (its boards move over and the old tag is deleted), or **Delete** a tag nobody uses.

**Players see the 🌐 Community tab** on the setup screen once at least 1 board is approved. Until then it only shows ⭐ Featured and ✨ Make your own. It opens on 🎲 Surprise me, a tile for each tag (**Browse** or **🎲** a random board in it) and ✨ New this week (boards approved in the last 7 days). Searching matches board names, tags, "Made by" and category names. Kids only filters everything to kid-friendly boards.

**Seeding boards** (`seed/`)
- Put packs in `seed/` (any `.json` pack, e.g. one downloaded from Make your own; it can include `"tags"`). Copies of the Featured themes are skipped (same name, or more than half the same questions): they're already in the game.
- Run it against a database (your `.env`, or the live one by passing its connection string):

  ```bash
  npm run seed-community
  ```

  ```bash
  DATABASE_URL="postgresql://…main branch…" npm run seed-community
  ```

- Each file goes into the review queue as a **pending** board with no "Made by" (set it while reviewing if you like). Review and approve them in `/admin` like any other board. Running it again skips boards that are already in the database.
- To find community boards that copy a Featured theme (any status), and then delete them:

  ```bash
  npm run seed-community -- --remove-featured-copies
  ```

  ```bash
  npm run seed-community -- --remove-featured-copies --confirm
  ```

  The first only lists them. Nothing is deleted without `--confirm`, on the live database too.

## Game night checklist (home wifi)

- **Same wifi:** everyone's phone must be on the same wifi as the laptop. A guest network usually won't work. Phones need wifi turned on, not mobile data.
- **Firewall:** if the Mac or Windows firewall asks whether to allow incoming connections for Node, click **Allow**.
- **Power:** keep the laptop plugged in and stop it from sleeping (Mac: System Settings → Lock Screen / Battery; Windows: Settings → System → Power).

## If something goes wrong

- **A phone dropped off:** it reconnects by itself and keeps the same name and team. Refreshing the page is also fine.
- **Phones can't open the link:** check the checklist above. Then make sure the IP in the QR link matches the one printed in the terminal.
- **"Port 3000 is already in use":** another program is using that port. Run `PORT=3100 npm start` instead.
- **Starting a new game ends the old one.** When you click **New game** and then **▶ Start**, the previous game closes: its phones see "This game has ended", and its old link says "Game not found". (**← Back to the current game** before Start keeps it going.)
- **The server was restarted:** the game lives in memory, so it's gone. Click **New game**, have everyone rejoin, and fix the scores with **− / +**.

## Editing questions and dares (packs)

All content lives in **packs** in the `packs/` folder. `packs/desi.json` is Desi Night (Board 1 "Bollywood", Board 2 "Desi Life"). `packs/world.json` is World Trivia (Board 1 "Around the World", Board 2 "History & Weirdness"). `packs/tv.json` is TV & Movies (Board 1 "Shows", Board 2 "Movies"). `packs/sports.json` is Sports (Board 1 "Rules & Basics", Board 2 "Legends & Moments", plus the optional football category from Desi Night). `packs/party.json` is a general Sparkle deck, used for any Sparkle mode a pack has no cards for.

A pack looks like this:

```json
{ "format": "buzz-pack-v2", "name": "Desi Night", "emoji": "🎬",
  "teams": ["Team Mogambo", "Team Basanti", "Team Gabbar", "Team Poo"],
  "boards": [ { "name": "Bollywood", "categories": [
    { "name": "Ek Tha Plot", "note": "optional hint for the host", "default": true, "questions": [
      { "value": 100, "question": "…", "answer": "…", "bonus": "…", "bonusPoints": 50,
        "funFact": "…", "verify": false } ] } ] } ],
  "sparkle": { "draw": { "easy": [], "medium": [], "tricky": [] }, "charades": [], "mimic": [] } }
```

- A pack has 1 or 2 boards. Each category has exactly 5 questions.
- **Board 1** values are 100, 200, 300, 400, 500. **Board 2** values are 200, 400, 600, 800, 1000.
- A built-in board can have 5–8 categories. Mark 5 with `"default": true` (or the first 5 are used).
- `teams` (optional) is up to 4 different team names, max 24 characters each. `note` is the category's "how to play" line, shown to the host. `bonus`, `bonusPoints`, `funFact`, `verify` and `sparkle` are optional. (An old `trapAnswer` field is ignored.) Leave out `bonus` to skip the bonus screen.
- Every pack is checked when a game starts. If something is wrong, **New game** shows exactly what, like "Board 2, category 3 has 4 questions, needs 5".

Draw points are `DRAW_LEVELS` in `server.js`, and how often the Sparkle Round starts is `SPARKLE_EVERY` at the top of `server.js` (6 by default). Changes show up the next time you click **New game**.

## Test

```bash
npm test
```

The database tests are skipped unless `TEST_DATABASE_URL` is set. They work in a throwaway schema that's deleted afterwards, so a local Postgres or your Neon dev branch is fine:

```bash
TEST_DATABASE_URL=postgresql://localhost/buzzin_dev npm test
```
