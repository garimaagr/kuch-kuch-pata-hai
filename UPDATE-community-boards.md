# BuzzIn — Community boards (v1)

> Save this in the project as `UPDATE-community-boards.md` and tell Claude Code: "Apply this one phase at a time. Test locally and stop after each phase. Don't push until I say."

## Goal
Let people share boards they make with "Make your own", so everyone gets more boards to play. v1 is deliberately slim:
- **invite-only publishing**: you need a share code to submit
- **every board is reviewed by me** before it goes live, including my own
- a **Community** tab with tag filters and 🎲 Surprise me

**Not in v1:** ratings, reports, remixing, mixing categories from different boards, accounts. Design the storage so category mixing is easy to add later.

**Naming:** "category" already means a column on a board. The labels used to organise boards are called **tags** everywhere: code, UI and prompts.

## Before starting
Check that these are done and pushed. If not, tell me and stop.
- Phase 0 security: host secret, room and player caps, rate limits, CSP, plain-text rendering.
- The setup-screen clean-up (compact Customise).

---

## Phase 1 — Database (Neon, free plan)
- Use Neon Postgres via the `pg` library. Connection string from the `DATABASE_URL` env variable, with SSL on.
- **Two databases:** use a separate Neon branch for local testing (`DATABASE_URL` in a local `.env`, which is gitignored) and the main branch on Render. Add setup steps to the README:
  - create the Neon project
  - copy the connection string
  - add it as `DATABASE_URL` in Render's Environment settings
  - add `ADMIN_PIN` too
- **If `DATABASE_URL` is missing,** the app still works exactly as today: the Community tab and sharing are hidden.
- Create the tables at startup with `CREATE TABLE IF NOT EXISTS` (one `schema.sql`). Use parameterised queries only, never string-built SQL.

**Tables**
- `tags`: id, slug (unique), name (≤ 24 characters), emoji, created_at
- `packs`: id (uuid), name, emoji, made_by (nullable, ≤ 30), kid_friendly (bool), suggested_tag (nullable, ≤ 20), sparkle (jsonb, nullable), status (`pending` | `approved` | `rejected` | `archived`), reject_reason, content_hash (unique), share_code_id, play_count (int, default 0), created_at, reviewed_at
- `pack_tags`: pack_id, tag_id
- `categories`: id, pack_id, board_index (0 or 1), position (0–7), name, description, is_default (bool), questions (jsonb). **One row per category**, so mixing categories from different boards later is just a query.
- `share_codes`: id, code_hash, label (e.g. "Jeff"), active (bool), uses (int), created_at

**Starting tags** (seeded once, each with an emoji): Movies, TV, Music, Sports, Cartoons & Kids, Desi, World & Travel, History, Science, Food, Gaming, Holidays. Kid-friendly is a separate flag on the pack, not a tag.

## Phase 2 — Tags in "Make your own"
- When building the prompt, insert the **current tag names from the database**.
- Add to the prompt:
  - Pick 1–3 tags from this list for the pack: {TAG LIST}.
  - If none fit well, also suggest one new tag in "suggestedTag" (max 20 characters).
  - Set "kidFriendly": true only if every question, bonus and sparkle card suits children.
- New optional pack fields: `tags` (array of strings), `suggestedTag` (string), `kidFriendly` (bool).
- **Validator:** tags not on the list are moved to `suggestedTag` (keep only the first) instead of failing. Max 3 tags.
- Playing a pack without sharing it works exactly as today.

## Phase 3 — "Share with community"
After **Check pack** succeeds, show a small, collapsed **🌐 Share with community** section. It's off by default, and playing right away is unaffected. It contains:
- **Share code** (required)
- **Made by** (optional, first name or nickname, ≤ 30 characters). Hint: "Shown on the board. Leave empty to stay anonymous."
- **Tags:** checkboxes for every tag, pre-ticked from Claude's `tags`, 1–3 required. Below them, if there is one: "Suggested new tag: X (the admin will decide)".
- **Kid-friendly** toggle, pre-set from Claude's answer.
- **Submit for review**, then the confirmation: "Thanks! It'll appear in Community once it's approved."

**On submit, the server:**
1. Re-validates the whole pack with the same validator.
2. Checks the share code: hashed, compared with `crypto.timingSafeEqual`, must be active.
3. Rejects duplicates, using a SHA-256 hash of the normalised pack.
4. Saves it as `pending`, with one `categories` row per category.
5. Returns the confirmation. Pending boards are never visible to the public.

**Limits**
- 3 submissions per share code per day, and 5 per IP per day.
- Max 100 pending boards in total. Beyond that: "The review queue is full, try again later."

## Phase 4 — Admin page (`/admin`)
**Login**
- `ADMIN_PIN` login, compared timing-safe. 5 attempts per 15 minutes per IP.
- On success, an httpOnly, Secure, SameSite=Strict session cookie (random token, kept in memory, expires after 12 hours).
- Every admin POST also checks the `Origin` header matches the site.

**Review queue (pending)**, oldest first. Each board shows:
- name, emoji, made_by, share code label, submitted time
- a **full preview**: every category with its description, then each question with its answer, bonus and fun fact. Questions with `verify: true` are highlighted ⚠️. The sparkle deck, if any.
- tags as editable checkboxes
- the suggested tag, if any, with three actions:
  - **Link to existing tag** (pick from a dropdown and tick it)
  - **Create as new tag** (enter name and emoji, then add it and tick it)
  - **Ignore**
- editable made_by and kid_friendly
- **Approve** or **Reject** (with an optional reason)

**Approved boards:** a list with tags, play count, and buttons to archive or unarchive and to edit tags or made_by.

**Tags manager**
- Create a tag, rename it or change its emoji.
- **Merge** one tag into another: its boards move over and the old tag is deleted.
- Delete a tag only if nothing uses it.

**Share codes**
- Create a code with a label. Show the code **once** and store only its hash.
- See the use count. Revoke a code.

## Phase 5 — Community tab
The setup screen gets tabs: **⭐ Featured** (the built-in themes, as today) · **🌐 Community** · **✨ Make your own**.

The **Community** tab shows only `approved` boards:
- **Tag chips:** only tags that have at least 1 approved board, each with a count.
- **Search box** (board name).
- **👨‍👩‍👧 Kid-friendly only** toggle.
- **Cards** showing: emoji, name, tags, "Made by X" if set, "Played N times".
- **🎲 Surprise me:** a random approved board that respects the selected tag and the kid-friendly toggle.

Picking a board opens the same summary and Customise panel as a Featured theme, then Start.
- Starting a game with a community board adds 1 to `play_count`, at most once per room.
- The server loads the pack from the database and **re-validates it** before using it.

**Public API:** returns only approved boards, a list endpoint with paging (20 at a time), and one endpoint to fetch a board by id. It never returns share codes, made_by of pending boards, or anything not approved.

## Phase 6 — Seed content
- Add a script, `npm run seed-community`, that loads every JSON file in `seed/` as a **pending** board with the share code label "Garima". I review and approve them in `/admin` like everything else.
- Put copies of the four built-in themes in `seed/`, plus any packs I add there.
- Don't show the Community tab to players until at least 1 board is approved. Until then, show the Featured and Make your own tabs only.

## Security checklist
- All text from the database is rendered with `textContent`, on the admin page too.
- The same CSP header applies to `/admin`.
- Parameterised SQL only.
- Never log share codes, the admin PIN or session tokens.
- made_by is cleaned like other text, and anything that looks like a link is rejected.
- Board ids are UUIDs. Pending and rejected boards return 404 to the public.
- Database errors show a friendly message and never expose SQL or stack traces.

## Tests
- Submit with a bad share code: rejected. Revoked code: rejected. 4th submission in a day: rejected. Duplicate pack: rejected.
- A pending board doesn't appear in Community or the public API. After approval it does. After archiving it disappears.
- Unknown tags from Claude become the suggested tag. Creating that tag in admin makes it appear in the filters and in the next generated prompt.
- Merging tags moves the boards.
- Admin: the wrong PIN 6 times is rate-limited. A POST without a session, or from another origin, is rejected.
- With no `DATABASE_URL`, the app works and Community and sharing are hidden.
- HTML in a board name or made_by shows as plain text.

## README
- Neon and Render setup (`DATABASE_URL`, `ADMIN_PIN`).
- How to make share codes and review boards.
- How seeding works.
