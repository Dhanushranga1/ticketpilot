-- Migration 0031: Enable pgvector + create embedding vector column
-- Replaces FAISS on-disk indices with pgvector in-database vectors.
-- Vectors survive deploys, no cold-start rebuild, no ephemeral FS dependency.

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add vector column (3072-dim to match existing gemini-embedding-001 embeddings)
-- Existing `embedding float4[]` column (migration 0019) stores raw vectors as Postgres arrays.
-- This new column uses pgvector's native `vector` type with distance operators.
ALTER TABLE app.chunks
    ADD COLUMN IF NOT EXISTS embedding_vec vector(3072);

-- 3. Backfill from existing float4[] column
-- Converts Postgres array to pgvector vector type.
-- Only updates rows where embedding exists and embedding_vec is null (idempotent).
UPDATE app.chunks
SET embedding_vec = embedding::vector
WHERE embedding IS NOT NULL
  AND embedding_vec IS NULL;

-- 4. Create HNSW index for fast approximate nearest-neighbor search
-- vector_cosine_ops = cosine distance operator (<=>), which is what we want for normalized embeddings.
-- m=16, ef_construction=64 are pgvector defaults (good balance of speed/recall).
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_vec
    ON app.chunks USING hnsw (embedding_vec vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 5. Deprecate FAISS snapshot table (keep for one release cycle, then drop)
-- app.faiss_snapshots (migration 0020/0021) stores FAISS binary blobs.
-- With pgvector, snapshots are unnecessary — vectors live in the indexed column.
-- NOT dropping yet to allow rollback if needed.
COMMENT ON TABLE app.faiss_snapshots IS 'DEPRECATED: pgvector replaces FAISS. Table kept for rollback safety.';
