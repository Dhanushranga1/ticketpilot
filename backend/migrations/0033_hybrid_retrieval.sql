-- Migration 0033: Hybrid retrieval support — full-text + trigram indexes
-- RRF fusion of vector (pgvector), lexical (tsvector), and fuzzy (pg_trgm).

-- 1. pg_trgm extension (fuzzy/typo-tolerant matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Chunks: generated tsvector column + GIN index
ALTER TABLE app.chunks
    ADD COLUMN IF NOT EXISTS text_search tsvector
    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS idx_chunks_text_search
    ON app.chunks USING gin (text_search);

-- 3. Chunks: trigram index for fuzzy substring similarity
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm
    ON app.chunks USING gin (text gin_trgm_ops);

-- 4. Tickets: tsvector on title+description for similar-ticket search
ALTER TABLE app.tickets
    ADD COLUMN IF NOT EXISTS text_search tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_tickets_text_search
    ON app.tickets USING gin (text_search);

-- 5. Tickets: embedding column for semantic similar-ticket retrieval
--    Populated when a ticket is resolved (J.3 — no backfill; fills over time).
ALTER TABLE app.tickets
    ADD COLUMN IF NOT EXISTS title_embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_tickets_title_embedding
    ON app.tickets USING hnsw (title_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 6. Trigger to keep ticket text_search in sync on updates
--    (Generated columns can't be updated in place; refresh via BEFORE UPDATE trigger.)
CREATE OR REPLACE FUNCTION app.refresh_ticket_search() RETURNS trigger AS $$
BEGIN
  NEW.text_search := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.description, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_text_search ON app.tickets;
CREATE TRIGGER trg_tickets_text_search
    BEFORE UPDATE OF title, description ON app.tickets
    FOR EACH ROW EXECUTE FUNCTION app.refresh_ticket_search();
