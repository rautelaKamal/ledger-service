-- migrations/009_policy_chunks_and_agent_runs.sql
-- Runs as ledger_owner. The runner wraps this file in BEGIN/COMMIT.
--
-- Step 7b: the assistant's two tables. policy_chunks: the policy documents,
-- chunked and embedded, read by every client alike. agent_runs: an audit log
-- of every question the assistant handled, the one thing it may write.

-- ───────────── Guard: pgvector must exist ─────────────
-- CREATE EXTENSION vector needs a superuser, which migrations (ledger_owner)
-- deliberately are not. k8s/base/postgres/init/00-roles.sql creates it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RAISE EXCEPTION 'extension vector must exist: run k8s/base/postgres/init/00-roles.sql first (npm run db:roles)';
    END IF;
END;
$$;

-- ───────────── policy_chunks ─────────────
-- One row per heading of a policy document in agent/policies/. The embedding
-- is gemini-embedding-2 at 768 dimensions (auto-normalised, cosine distance).
-- Ingestion (agent/scripts/ingest_policies.py, as ledger_owner) is idempotent
-- by content_hash: unchanged chunks are kept, changed ones re-embedded, removed
-- ones deleted. No row-level security: a policy is the same document for every
-- client; there is nothing client-specific to hide.
CREATE TABLE policy_chunks (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_file     TEXT        NOT NULL,
    heading         TEXT        NOT NULL,
    content         TEXT        NOT NULL,
    content_hash    TEXT        NOT NULL,          -- sha256 hex of source_file + heading + content
    embedding       vector(768) NOT NULL,
    embedding_model TEXT        NOT NULL,          -- which model made it; a change means re-ingest
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT policy_chunks_content_hash_key    UNIQUE (content_hash),
    CONSTRAINT policy_chunks_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT policy_chunks_source_file_format  CHECK (source_file ~ '^[a-z0-9-]+\.md$'),
    CONSTRAINT policy_chunks_content_not_empty   CHECK (length(content) BETWEEN 1 AND 8000)
);

-- Nearest-neighbour search by cosine distance (ORDER BY embedding <=> $1 LIMIT 3).
CREATE INDEX policy_chunks_embedding_idx ON policy_chunks
    USING hnsw (embedding vector_cosine_ops);

-- The assistant reads policies; only the ingestion script (the owner) writes them.
GRANT SELECT ON policy_chunks TO ledger_agent;

-- ───────────── agent_runs ─────────────
-- Every question the assistant handled: what was asked, what it fetched (tool
-- names and arguments; the client id is never a tool argument, so it cannot be
-- here), which policy chunks it read, what it answered, whether the answer was
-- verified, and what it cost. Append-only.
--
-- Why a "read-only" assistant may write this: read-only means it cannot change
-- the LEDGER. This is not ledger data; it is the record of the assistant's own
-- behaviour, needed to debug it, to rate-limit it, and to evaluate it (7c).
-- It writes only its own rows for the current client (the policy below), and
-- can read back nothing but the three columns the rate limit and RETURNING need.
CREATE TABLE agent_runs (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id           TEXT        NOT NULL,
    question            TEXT        NOT NULL,
    category            TEXT        NOT NULL,
    tools_called        JSONB       NOT NULL DEFAULT '[]',   -- [{name, args, ok}]
    retrieved_chunk_ids BIGINT[]    NOT NULL DEFAULT '{}',
    answer              TEXT        NOT NULL,
    citations           JSONB       NOT NULL DEFAULT '[]',   -- [{type, id}]
    verified            BOOLEAN     NOT NULL,
    verify_failures     JSONB       NOT NULL DEFAULT '[]',   -- what the verifier rejected, per attempt
    attempts            INTEGER     NOT NULL,
    model               TEXT        NOT NULL,
    prompt_tokens       INTEGER     NOT NULL DEFAULT 0,
    completion_tokens   INTEGER     NOT NULL DEFAULT 0,
    latency_ms          INTEGER     NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT agent_runs_client_id_length        CHECK (length(client_id) BETWEEN 1 AND 255),
    CONSTRAINT agent_runs_question_length         CHECK (length(question) BETWEEN 1 AND 2000),
    CONSTRAINT agent_runs_category_valid          CHECK (category IN ('account', 'policy', 'both', 'out_of_scope')),
    CONSTRAINT agent_runs_attempts_range          CHECK (attempts BETWEEN 0 AND 2),
    CONSTRAINT agent_runs_tokens_not_negative     CHECK (prompt_tokens >= 0 AND completion_tokens >= 0),
    CONSTRAINT agent_runs_latency_not_negative    CHECK (latency_ms >= 0),
    CONSTRAINT agent_runs_tools_called_is_array   CHECK (jsonb_typeof(tools_called) = 'array'),
    CONSTRAINT agent_runs_citations_is_array      CHECK (jsonb_typeof(citations) = 'array')
);

-- The rate limit: "how many questions did this client ask in the last 24 hours?"
CREATE INDEX agent_runs_client_created_idx ON agent_runs (client_id, created_at);

CREATE FUNCTION agent_runs_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'agent_runs are append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER agent_runs_no_update_or_delete
    BEFORE UPDATE OR DELETE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION agent_runs_block_changes();

-- The assistant may INSERT a run for the client it is acting for, and read back
-- only (id, client_id, created_at) of that client's runs: the rate limit's
-- count and the INSERT's RETURNING id. Row-level security makes "that client's"
-- true in both directions: an INSERT with another client's id, or a count over
-- another client, is refused.
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_own_runs_insert ON agent_runs
    FOR INSERT TO ledger_agent WITH CHECK (client_id = agent_client_id());
CREATE POLICY agent_own_runs_select ON agent_runs
    FOR SELECT TO ledger_agent USING (client_id = agent_client_id());

GRANT INSERT (client_id, question, category, tools_called, retrieved_chunk_ids, answer, citations,
              verified, verify_failures, attempts, model, prompt_tokens, completion_tokens, latency_ms)
    ON agent_runs TO ledger_agent;
GRANT SELECT (id, client_id, created_at) ON agent_runs TO ledger_agent;

-- Deliberately absent: UPDATE/DELETE for anyone (the trigger blocks the owner
-- too); SELECT on question, answer or anything else for ledger_agent; any
-- write on policy_chunks for ledger_agent.
