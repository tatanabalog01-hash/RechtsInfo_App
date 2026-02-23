CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS law_chunks (
  id BIGSERIAL PRIMARY KEY,
  version_tag TEXT NOT NULL DEFAULT 'legacy',
  law TEXT NOT NULL,
  section TEXT,
  title TEXT,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS law_chunks_embedding_idx
  ON law_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS law_chunks_law_idx ON law_chunks (law);
CREATE INDEX IF NOT EXISTS law_chunks_section_idx ON law_chunks (section);
CREATE INDEX IF NOT EXISTS law_chunks_version_idx ON law_chunks (version_tag);

CREATE TABLE IF NOT EXISTS law_dataset_versions (
  version_tag TEXT PRIMARY KEY,
  source_url TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('loading', 'active', 'failed', 'archived'))
);

CREATE TABLE IF NOT EXISTS law_dataset_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
