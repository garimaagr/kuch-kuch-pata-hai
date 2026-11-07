# Build brief: "Filmy Buzz" — a simple Bollywood trivia board with phone buzzers

> Paste this into Claude Code, or save it as `BRIEF.md` in an empty folder and say "build what BRIEF.md describes". Things in [brackets] are mine to decide.

## Keep it simple
This is for a fun night with friends, not a product. Keep the code small and the pages plain: no accounts, no database, no fancy animations, no extra features I didn't ask for.

## What it is
A Jeopardy-style Bollywood quiz. There's a board of funny categories, each worth 100–500 points. The host picks a tile and teams race to buzz in from their phones. Between board rounds there's a **Sparkle Round** of dares, charades and Pictionary, where teams earn bonus points for being funny.

Don't use any TV show's name, logo or music. The name is "Filmy Buzz" or [my name].

## Pages

**Host page (`/host`, on a laptop shared to the TV)**
- "New game" creates a room code and a QR code for players to join.
- The **lobby** lists who has joined. A **"Make random teams"** button shuffles players into [2–4] teams with filmy names ("Team Mogambo", "Team Basanti", "Team Gabbar", "Team Poo"). There's a reshuffle button, and the host can move a player to another team.
- **Board:** a grid of 5 categories × 5 values. Click a tile and the question shows big on screen.
- **Question screen:** "Open buzzers", then the buzz order appears ("1. Team Basanti — Priya", "2. Team Mogambo — Rohan").
  - ✅ **Correct** adds the points and goes back to the board.
  - ❌ **Wrong** subtracts the points and locks that team out. The next team in line gets a turn.
  - **Show answer** and **Back to board**.
- Used tiles go grey. Team scores sit along the bottom, with +/− buttons to fix mistakes.
- A **"Sparkle Round"** button opens the dare screen (see below).

**Player page (`/join/CODE`, on phones)**
- Enter a name and wait in the lobby. Once teams are made, the phone shows your team name and color.
- One giant **BUZZ** button. It's grey until the host opens buzzers. Tap it, the phone vibrates, and it says "You're first!" or "Too slow — Team X got it".
- During charades or Pictionary, **only the chosen performer's phone shows the secret movie title**. Everyone else's phone says "Guess!".
- If the page refreshes, the player rejoins as the same person (keep an ID in localStorage, wrapped in try/catch).

The host page is also what's shown on the TV, so there's no separate stage view.

## Buzzer rules
- The server decides who was first, by the order buzzes reach it.
- Buzzes sent before buzzers are opened are ignored. Only the first buzz from each team counts.
- A team that answered wrong can't buzz again on that question.

## Sparkle Round (no buzzers)
1. The host picks which team goes next. **That team chooses its own performer.** The host taps that person's name on the host page. There's no random wheel.
2. The host draws a random card from the dare deck (with a "skip card" button). The card shows on the TV, and a 60-second timer starts.
3. Scoring depends on the card type:
   - **Charades / Pictionary:** the secret movie title is shown only on the performer's phone and is hidden from the TV. If their team guesses it within 60 seconds, the host taps **Guessed** (+[100]). Pictionary is drawn on paper or a whiteboard; the app doesn't need a drawing canvas.
   - **Mimic / Act it out:** the host gives sparkle points for how funny it was, with **+25 / +50 / +100** buttons.
4. A card isn't drawn again in the same game.

### Dare deck (put in `dares.json`)

**Mimic**
- Say "Rahul… naam toh suna hoga" with the full SRK arms-out pose
- Order chai like Amitabh asking a KBC question ("Lock kiya jaaye?")
- Do Salman taking his shirt off, without taking anything off
- Do Rajinikanth putting on sunglasses
- Say "Mere paas maa hai" like it's an Oscar speech

**Act it out**
- The DDLJ train scene: one teammate runs for the train while another plays Raj with a hand out
- A Bollywood slow-motion hero entry (teammates do the wind effect)
- A Bollywood death scene, at least 30 seconds long, with a final dialogue
- Propose to a teammate like a 90s hero
- Play a villain threatening the hero, but the threat is about dishes in the sink
- Play a TV-serial mother-in-law reacting to burnt dal (three dramatic zooms minimum)

**Charades** (secret title on the performer's phone): Sholay, Andaz Apna Apna, Hera Pheri, Jab We Met, Chak De! India, Taare Zameen Par, Munna Bhai M.B.B.S., Zindagi Na Milegi Dobara, Golmaal, Yeh Jawaani Hai Deewani

**Pictionary** (secret title on the performer's phone): Mr. India, Koi… Mil Gaya, Devdas, Mughal-e-Azam, Krrish, Dil Chahta Hai, Bajrangi Bhaijaan, Gully Boy, Jodhaa Akbar, Barfi!

## Board questions (put in `questions.json`)
Use these exactly. Each item has `value`, `question` and `answer`. The host reads the "Overly Wordy Plots" questions in a professor voice.

**Badly Explained Plots**
| Pts | Question | Answer |
|---|---|---|
| 100 | Retired cop hires two small-time crooks. The villain mostly wants to know how many men there were. | Sholay |
| 200 | Man becomes invisible with a wristwatch, but red light ruins it every time. | Mr. India |
| 300 | Alien lands in Rajasthan, and his biggest problem the whole film is that someone stole his remote. | PK |
| 400 | Wedding gets called off, so she goes on the honeymoon alone and has a better time. | Queen |
| 500 | Junior artist dies in a fire, is reborn as a superstar, and spends the second half running the world's longest prank. | Om Shanti Om |

**Overly Wordy Plots**
| Pts | Question | Answer |
|---|---|---|
| 100 | An ethnographic record of joint-family wedding logistics, about three hours long, in which a dog plays a key part in delivering messages. | Hum Aapke Hain Koun..! |
| 200 | A regulatory review of fertility services in West Delhi, told through one unusually successful young man. | Vicky Donor |
| 300 | A rare documented failure of Mumbai's dabbawala system leads to a lunchtime pen-pal relationship. | The Lunchbox |
| 400 | On the socio-romantic effects of premature hair loss in Kanpur. | Bala |
| 500 | A critique of engineering-college teaching, including an unauthorised childbirth assisted by a vacuum cleaner. | 3 Idiots |

**Bad English Translations**
| Pts | Question | Answer |
|---|---|---|
| 100 | "Something Something Happens" | Kuch Kuch Hota Hai |
| 200 | "Sometimes Happiness, Sometimes Sadness" | Kabhi Khushi Kabhie Gham |
| 300 | "Someone Got Found" | Koi… Mil Gaya |
| 400 | "Tomorrow May or May Not Come" | Kal Ho Naa Ho |
| 500 | "Keep At It, Munna Brother" | Lage Raho Munna Bhai |

**Emoji Movies**
| Pts | Question | Answer |
|---|---|---|
| 100 | 🚂🌻🇨🇭 | Dilwale Dulhania Le Jayenge |
| 200 | 🏏🌧️🇬🇧💰 | Lagaan |
| 300 | 👨‍👧‍👧🤼‍♀️🥇 | Dangal |
| 400 | 🏍️💨💰👮 | Dhoom |
| 500 | 🏰👻🌀 | Bhool Bhulaiyaa |

**Stars, Badly Described**
| Pts | Question | Answer |
|---|---|---|
| 100 | Has played someone called Raj or Rahul so often it's basically his legal name. | Shah Rukh Khan |
| 200 | Angry young man of the 70s who now asks crorepati questions. | Amitabh Bachchan |
| 300 | Built a whole brand on taking his shirt off and wearing a turquoise bracelet. | Salman Khan |
| 400 | Does about four films a year and is famous for waking up before sunrise. | Akshay Kumar |
| 500 | Played a college student at 44 and releases about one film every few years. | Aamir Khan |

I'll edit the JSON files by hand to add more. No in-app editor needed.

## Tech (keep it minimal)
- One small **Node + Express + Socket.IO** server serving plain HTML/CSS/vanilla JS pages. No database: game state lives in memory.
- Fire the buzz on `pointerdown` and use `touch-action: manipulation` so phones don't zoom.
- **No hosting: it runs on my laptop over home wifi.** `npm install && npm start` should:
  - listen on all network interfaces (`0.0.0.0`), port from `process.env.PORT` or 3000
  - find the laptop's local wifi IP (e.g. `192.168.x.x`) automatically and print it
  - make the host page's QR code and join link use that IP, never `localhost`
- Everything must work over plain `http://` on the local network: no HTTPS-only browser features, and no internet needed during the game (serve all JS/CSS locally, no CDNs).
- If a phone loses connection it should auto-reconnect. The host can fix scores with the +/− buttons.
- README "Game night checklist": everyone joins the same wifi as the laptop (not a guest network, and phones with wifi turned on, not mobile data); allow incoming connections if the Mac/Windows firewall asks; plug the laptop in and stop it from sleeping.
- Keep dependencies to Express, Socket.IO and one small QR code library.
- One small test of the buzz-order logic.

## Build order
1. Join, lobby and random teams.
2. Buzzer, with the host seeing the buzz order. **Stop and let me test it on phones.**
3. Board, questions and scoring.
4. Sparkle Round (performer picked by the team, dare deck, secret title on the performer's phone, timer, points).
5. A short README with the game night checklist.
