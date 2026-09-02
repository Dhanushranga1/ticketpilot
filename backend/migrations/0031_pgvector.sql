-- Migration 0031: Enable pgvector + create embedding vector column
-- Replaces FAISS on-disk indices with pgvector in-database vectors.
-- Vectors survive deploys, no cold-start rebuild, no ephemeral FS dependency.

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add vector column. 768-dim — matches gemini-embedding-001 default output
--    and stays under pgvector's 2000-dim HNSW limit.
--    (Earlier draft used 3072 — invalid for hnsw on Supabase pgvector.)
ALTER TABLE app.chunks
    ADD COLUMN IF NOT EXISTS embedding_vec vector(768);

-- 3. Backfill from existing float4[] column where dims match
--    (3072-dim rows from the FAISS era are ignored — re-embed on next ingest)
UPDATE app.chunks
SET embedding_vec = embedding::vector
WHERE embedding IS NOT NULL
  AND embedding_vec IS NULL
  AND array_length(embedding, 1) = 768;

-- 4. Create HNSW index for fast approximate nearest-neighbor search
-- vector_cosine_ops = cosine distance operator (<=>).
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_vec
    ON app.chunks USING hnsw (embedding_vec vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 5. Deprecate FAISS snapshot table (keep for one release cycle, then drop)
COMMENT ON TABLE app.faiss_snapshots IS 'DEPRECATED: pgvector replaces FAISS. Table kept for rollback safety.';
