-- Docker init script: enable pgvector extension
-- Runs once when the container is first initialised.
CREATE EXTENSION IF NOT EXISTS vector;
