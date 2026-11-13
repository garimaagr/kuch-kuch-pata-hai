-- Community boards. Run at every startup: everything here is safe to run again.
-- A "category" is a column on a board. The labels that organise boards are "tags".

CREATE TABLE IF NOT EXISTS tags (
  id         serial PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  emoji      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  emoji         text NOT NULL DEFAULT '',
  made_by       text CHECK (made_by IS NULL OR char_length(made_by) <= 30),
  kid_friendly  boolean NOT NULL DEFAULT false,
  suggested_tag text CHECK (suggested_tag IS NULL OR char_length(suggested_tag) <= 20),
  board_names   jsonb NOT NULL DEFAULT '[]', -- e.g. ["Board 1: Bollywood", "Board 2: ..."]
  teams         jsonb,                       -- optional themed team names
  sparkle       jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'archived')),
  reject_reason text,
  content_hash  text NOT NULL UNIQUE,        -- SHA-256 of the normalised pack, to refuse duplicates
  play_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz
);
-- Share codes were removed (anyone can submit; everything is reviewed). Tidy up older databases.
ALTER TABLE packs DROP COLUMN IF EXISTS share_code_id;
DROP TABLE IF EXISTS share_codes;

CREATE INDEX IF NOT EXISTS packs_status_created_idx ON packs (status, created_at);

CREATE TABLE IF NOT EXISTS pack_tags (
  pack_id uuid    NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  tag_id  integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (pack_id, tag_id)
);
CREATE INDEX IF NOT EXISTS pack_tags_tag_idx ON pack_tags (tag_id);

-- One row per category, so a board mixing categories from different packs is just a query later.
CREATE TABLE IF NOT EXISTS categories (
  id          serial PRIMARY KEY,
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  board_index smallint NOT NULL CHECK (board_index IN (0, 1)),
  position    smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  name        text NOT NULL,
  description text,                          -- the "how to play" line (the pack's "note")
  is_default  boolean NOT NULL DEFAULT false,
  questions   jsonb NOT NULL,
  UNIQUE (pack_id, board_index, position)
);

-- One-off bookkeeping, e.g. "the starting tags were added" (so a tag deleted in /admin stays deleted).
CREATE TABLE IF NOT EXISTS app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
