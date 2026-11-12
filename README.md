# 🎬 Kuch Kuch Pata Hai

A Bollywood trivia board for a night with friends. The laptop runs the game and is shown on the TV; everyone buzzes in from their phone. Run it on your laptop over home wifi (no internet needed), or play online from Render.

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
2. Click **New game**. Friends scan the QR code (or type the link) and enter their name.
3. Click **Make random teams** (2–4 teams). Use **Reshuffle** or the dropdowns to move people around.
4. Click **Go to the board →** and play:
   - Click a tile, read the question, then **Open buzzers**. The buzz order shows on screen.
   - **✅ Correct** adds the points, then shows that team a **bonus challenge**: tap **Bonus done +50** or **Skip bonus**. **❌ Wrong** takes the points away, locks that team out, and passes the turn to the next team in line.
   - **😂 +5** buttons (one per team) reward funny wrong answers. Tap as often as you like.
   - **Show answer** and **Back to board** when you're done. Used tiles go grey.
   - Fix any mistakes with the **− / +** buttons under each team's score.
   - **Board 2 →** (top right) switches to the second board, and **← Board 1** goes back. Scores carry over, and each board remembers its used tiles.
5. **✨ Sparkle Round** starts by itself after every 6 finished questions (answered correctly, or answer shown). You can also open it with the **✨ Sparkle Round** button on the board, or leave it with **Skip Sparkle**.
   - Pick the team, then the mode: 🎨 **Draw (Diwali)**, 🤐 **Dumb Charades** or 🎭 **Mimic**. For Draw, the team also picks a difficulty: 🌶️ Easy (50), 🌶️🌶️ Medium (100) or 🌶️🌶️🌶️ Tricky (200). The team chooses its performer, and you tap their name to draw a card. **Skip card** draws another.
   - Draw / Dumb Charades: the secret word or movie shows only on the performer's phone. Draw on paper or a whiteboard. For Draw, the TV shows the difficulty and points, and **🎉 Guessed!** adds them automatically.
   - Mimic: the prompt shows on the TV.
   - Tap **▶ Start timer** when the performer is ready (60 seconds). **⏸ Stop timer** pauses it.
   - Give **+25 / +50 / +100**, any amount in the box, or **No points**. Then you're back on the board.

## Play online (Render)

Hosted on Render, the game has a public https link, so phones can join on any network, mobile data included.

**One-time setup**
1. Put this folder in a GitHub repository (a private one is fine).
2. Sign up at [render.com](https://render.com) with your GitHub account.
3. In Render, click **New → Blueprint**, pick the repository and click **Apply**. Render reads `render.yaml` and creates a free web service.
4. When the deploy finishes, open `https://<your-service>.onrender.com/host`. The QR code and join link use that address automatically.

**Updating questions:** edit the JSON files, commit and push. Render redeploys by itself in a minute or two.

**Things to know about the free plan**
- It **sleeps after about 15 minutes with no visitors**. Open the host page a minute before people arrive, because the first load can take 30–60 seconds.
- The game lives in memory, so a redeploy or restart ends the current game. Don't push changes mid-game.
- Anyone with the link could open the host page and start their own game. Your game's room code keeps theirs separate.

**Keeping the public link safe**
- Only the laptop that clicked **New game** can run that game. It keeps a secret key, so seeing the room code on the TV isn't enough to take over.
- **Optional host PIN:** in Render, open the service → **Environment** → **Add Environment Variable**, set `HOST_PIN` to a number you choose, and save. After that, `/host` asks for the PIN before starting a game. Leave it unset for no PIN.
- Built-in limits: at most 20 games at once, 30 players per game, 5 new games per network every 10 minutes, and games idle for 3 hours are deleted.

## Game night checklist (home wifi)

- **Same wifi:** everyone's phone must be on the same wifi as the laptop. A guest network usually won't work. Phones need wifi turned on, not mobile data.
- **Firewall:** if the Mac or Windows firewall asks whether to allow incoming connections for Node, click **Allow**.
- **Power:** keep the laptop plugged in and stop it from sleeping (Mac: System Settings → Lock Screen / Battery; Windows: Settings → System → Power).

## If something goes wrong

- **A phone dropped off:** it reconnects by itself and keeps the same name and team. Refreshing the page is also fine.
- **Phones can't open the link:** check the checklist above. Then make sure the IP in the QR link matches the one printed in the terminal.
- **"Port 3000 is already in use":** another program is using that port. Run `PORT=3100 npm start` instead.
- **The server was restarted:** the game lives in memory, so it's gone. Click **New game**, have everyone rejoin, and fix the scores with **− / +**.

## Editing questions and dares (packs)

All content lives in **packs** in the `packs/` folder. `packs/desi.json` is the current game (Board 1 "Bollywood", Board 2 "Desi Life"). `packs/party.json` is a general Sparkle deck, used for any Sparkle mode a pack has no cards for.

A pack looks like this:

```json
{ "format": "buzz-pack-v2", "name": "Desi Night", "emoji": "🪔",
  "boards": [ { "name": "Bollywood", "categories": [
    { "name": "Ek Tha Plot", "note": "optional hint for the host", "default": true, "questions": [
      { "value": 100, "question": "…", "answer": "…", "bonus": "…", "bonusPoints": 50,
        "funFact": "…", "trapAnswer": "…", "verify": false } ] } ] } ],
  "sparkle": { "draw": { "easy": [], "medium": [], "tricky": [] }, "charades": [], "mimic": [] } }
```

- A pack has 1 or 2 boards. Each category has exactly 5 questions.
- **Board 1** values are 100, 200, 300, 400, 500. **Board 2** values are 200, 400, 600, 800, 1000.
- A built-in board can have 5–8 categories. Mark 5 with `"default": true` (or the first 5 are used).
- `note`, `bonus`, `bonusPoints`, `funFact`, `trapAnswer`, `verify` and `sparkle` are optional. Leave out `bonus` to skip the bonus screen.
- Every pack is checked when a game starts. If something is wrong, **New game** shows exactly what, like "Board 2, category 3 has 4 questions, needs 5".

Draw points are `DRAW_LEVELS` in `server.js`, and how often the Sparkle Round starts is `SPARKLE_EVERY` at the top of `server.js` (6 by default). Changes show up the next time you click **New game**.

## Test

```bash
npm test
```
