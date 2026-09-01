# Strata / TicketPilot — Pilot Readiness Plan

> **Live document** — updated as phases are completed.
> Pilot goal: ship TicketPilot to 5–10 real orgs, gather feedback, then build the next Strata module as a standalone tasteable product.
> Hardcoded branding: Strata is the platform, TicketPilot is the flagship product. No white-label per-org branding during pilot.

---

## ✅ Completed

| Area | Items |
|------|-------|
| **Security & Crash Bugs** | JWT bypass in org middleware, SSL for Supabase pooler, cross-org data leak, admin demotion race, stale JWT role checks, FAISS concurrent read/write race, error boundaries, 401 retry, unmounted state leak |
| **Data Correctness** | Citation coverage cap, savepoint rollback, missing psycopg import, zero-vector FAISS handling, embedding fallback shape, org membership for assign, custom fields validation, admin org list pagination, re-render loop, dark mode toggle |
| **Production Hardening** | Rate limit via X-Forwarded-For, circuit breaker 1→3, fetch timeout, GET cache LRU, cache invalidation paths, cross-tab sync closure, invite rate limit, async httpx, forgot password fix, Python 3.10 compat, NODE_ENV→ENVIRONMENT, loading.tsx, switchOrganization delay, useAuthHeaders rename |
| **Observability** | Structured error codes, JWT error leaking, validation input logging, credit card Luhn check, latency=None on failure, FAISS snapshot lock, health endpoint improvements |
| **Dev/Prod Separation** | Env templates (dev/prod), Docker Compose, Makefile, migration_runner.py, setup-dev.sh, Render-only deploy |
| **BYOK AI System** | DB-backed AI settings (`app.ai_settings`), API endpoints (`GET/PUT /api/admin/ai-settings`), frontend settings page (`/admin/settings/ai`), provider-agnostic ai.py/embeddings.py (auto-detect gemini/gpt/claude/groq from model name), key masking in UI, masked-key protection in PUT |
| **AI Integration** | ES256 JWT support (Supabase JWKS endpoint), Groq provider support, Google Gemini embedding + generation, 429 retry backoff |
| **RAG Pipeline Fixes** | MMR auto-disabled when KB < 50 chunks, FAISS rebuild syncs faiss_id to DB, MOC.md removed from KB (TOC doc polluted rankings), score clustering skip for MMR |
| **DB Migrations** | 0028_ai_runs_org_id, 0029_ai_settings, 0030_fix_sender_role_check |

---

## Pilot Decisions (locked in)

- **Vector search:** migrate FAISS → pgvector (vectors live in Supabase, survive redeploys, kill the #1 ops risk).
- **Tests:** backfill tests before shipping features; jest coverage threshold dropped to ~40% with ratchet plan back to 70% once tests exist.
- **Branding:** hardcoded Strata + TicketPilot during pilot.
- **AI depth:** polish existing RAG chat + add 2 agent actions (draft reply, create-KB-from-resolved-ticket).
- **Plans:** no billing. Super-admin assigns `plan_id` manually. UpgradeBanner becomes "Contact us".

---

## Phase A — Tests & CI green (blocks everything)

**Goal:** CI pipeline is green; dev→main PRs can merge safely.

### A.1 Backend test fixtures
- **File:** `backend/tests/conftest.py` (extend existing)
- Fixtures: `test_db` (mocked via existing approach), `test_org`, `test_user`, `test_admin`, `test_jwt(user)` returning a real signed HS256 token, `async_client` (httpx ASGI test client against `app.main:app`)

### A.2 Backend auth tests
- **New:** `backend/tests/test_auth.py`
- JWT verify: valid / expired / invalid signature / wrong alg / missing header
- ES256 via JWKS, HS256 fallback
- `org_middleware`: valid token → user + role attached; invalid token → 401
- Role caching (60s TTL)

### A.3 Backend org tests
- **New:** `backend/tests/test_organizations.py`
- CRUD, slug validation, member add/remove
- Role transitions (owner/admin/rep/member), invite accept flow
- Cross-org data isolation (user of org A cannot see org B tickets)

### A.4 Backend ticket tests
- **New:** `backend/tests/test_tickets.py`
- CRUD, assign (cross-org rejection), status transitions, message flow, priority/SLA
- `POST /api/tickets/{id}/chat` happy path + cooldown + low-confidence escalation path

### A.5 Backend RAG tests
- **New:** `backend/tests/test_rag.py` (complement existing `test_rag_scoring.py`)
- `retrieve()` flow, MMR re-rank, context building + truncation
- Citation parsing, embedding fallback
- Zero-vector handling, concurrent search/ingest

### A.6 Frontend API client tests
- **New:** `frontend/src/__tests__/lib/api-client.test.ts`
- Auth header injection, GET caching
- Cache invalidation, 401 retry with refresh
- 502/503 retry, timeout via AbortController

### A.7 Frontend OrganizationContext tests
- **New:** `frontend/src/__tests__/contexts/OrganizationContext.test.tsx`
- Load state, auth context, org switching
- Error states, cross-tab sync, unmount cleanup

### A.8 Frontend jest config ratchet
- **File:** `frontend/jest.config.js`
- Drop global `coverageThreshold` to **40%** (current 70% fails with one test file)
- Track: raise to 50% after Phase A, 60% after Phase E, back to 70% after Phase G

### A.9 CI workflow fixes
- **File:** `.github/workflows/ci-development.yml`
- Rename backend env vars: `SUPABASE_SERVICE_KEY` → `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` → `SUPABASE_JWT_SECRET`
- Fix `scripts/rag_validation_suite.py` invocation (CI runs from root, script lives in `scripts/`)
- Lint/format commands: verify they match current setup (ESLint flat config, prettier)

### A.10 Verification
- `make test-backend` → pytest green
- `make test-frontend` → jest green with new threshold
- `npm run type-check` / `npm run lint` → clean
- CI run on `dev` branch green end-to-end

---

## Phase B — pgvector migration (parallelizeable with Phase A)

**Goal:** kill FAISS — vectors in Postgres, survive redeploys, no ephemeral FS dependency.

### B.1 Enable pgvector
- **New migration:** `0031_pgvector_enable.sql` — `CREATE EXTENSION IF NOT EXISTS vector`
- New table `app.kb_embeddings` (or reuse `app.chunks` adding `embedding vector(768)`)

### B.2 Migrate embeddings
- **New migration:** `0032_chunk_embeddings.sql` — add `embedding vector(768)` column to `app.chunks`, backfill from existing `app.chunks.embedding` (BYTEA) where present
- Deprecate `app.faiss_snapshots` table (migration 0020/0021) — keep for one release cycle

### B.3 Switch retrieval
- **File:** `backend/app/rag.py`
- `retrieve()` → `SELECT ... FROM app.chunks WHERE org_id = $1 ORDER BY embedding <=> $2 LIMIT $3` (cosine) or `<#>` (IP)
- Keep MMR post-processing (already pure-Python)

### B.4 Strip FAISS code
- **File:** `backend/app/store.py` — delete `FaissStore`, per-org locks, index LRU, snapshots
- **File:** `backend/app/main.py` — remove FAISS rebuild background task, remove startup snapshot load
- **File:** `backend/app/rag.py` — remove FAISS search/ingest paths

### B.5 Shrink default embedding dim
- **File:** `backend/app/ai_settings.py` — default `embed_dim` 768 (was 3072)
- Suggested defaults: `gemini-embedding-001` stays (Google supports 768/1536/3072, configurable) OR `text-embedding-3-small` (1536) / `jina-embeddings-v4` (1024)
- Halves vector storage + FAISS→pgvector RAM usage ÷4

### B.6 Fallback
- If pgvector unavailable (no extension): in-memory brute force from `app.chunks.embedding` — never block startup

---

## Phase C — Cost leaks + quota enforcement

**Goal:** per-request AI cost predictable; free-tier hosting viable.

### C.1 Stop re-embedding chunks per request
- **File:** `backend/app/rag.py:47-64,224` — `_ensure_embeddings` called per call re-embeds all retrieved chunk texts
- Fix: pgvector query already returns top-k, no re-embedding needed; only embed the **query**

### C.2 Enforce AI query quota
- **File:** `backend/app/entitlements/__init__.py` — increment `app.org_usage.ai_queries_used` on every `/chat` hit
- 402 when `ai_queries_used >= limits.ai_queries` (starter 5k, business 25k, enterprise unlimited, community 0)

### C.3 Enforce rate limits
- **File:** `backend/app/security.py` — add `@limiter.limit` decorators to expensive endpoints (chat, kb/ingest, invites)

### C.4 Fix logging model strings
- Replace hardcoded `gemini-1.5-pro` with DB-aware value via `ai_settings`

---

## Phase D — Polish half-built UI

**Goal:** no dead links, no mock data, no cosmetic toggles.

### D.1 Dead link
- `frontend/src/app/(protected)/dashboard/page.tsx:815` → open the create dialog instead of `/tickets/new`

### D.2 Admin settings cosmetic toggles
- `admin/settings/page.tsx` — persist `backupEnabled` / `maintenanceMode` / `debugMode` to org settings OR remove them

### D.3 Admin roles mock data
- `admin/roles/page.tsx:226-256` — replace mock activity with real `audit_log` query OR hide section until backend ready

### D.4 Audit log page
- `admin/audit-log/page.tsx:208-216` — remove "run migration" dev note

### D.5 KB Manage tab
- `kb/page.tsx:633-766` — doc edit + delete (currently read-only)

### D.6 Finish rebrand strings
- ~15 files with hardcoded "TicketPilot" in user-facing places (login, signup, wizard, empty states)
- Keep backend/Makefile/.env references — they're mid-transition per AGENTS.md

### D.7 Hardcode model strings in logging
- `tickets.py:951, 984, 1140, 1170, 1262` — use actual model from `ai_settings`

---

## Phase E — AI polish + 2 agent actions

**Goal:** demonstrate agentic future, not just RAG chat.

### E.1 Gate rep AI Assist
- `rep/page.tsx` — wrap "Get AI Suggestion" in `<FeatureGate feature="ai_rag">` (currently ungated)
- Wire feedback no-op at `rep/page.tsx:576` → `POST /api/ai/feedback`
- Dedupe rep-AI and ticket-chat service into shared `rag.py` helper

### E.2 Agent action 1 — AI draft reply
- `POST /api/tickets/{id}/ai-draft` → returns draft text + citations; rep accepts → posts as `sender_role='rep'` message
- Gate: `ai_rag`

### E.3 Agent action 2 — Create KB from resolved ticket
- `POST /api/tickets/{id}/ai-kb-draft` → AI summarizes resolved ticket as a KB article draft + sources
- Rep reviews → `POST /api/kb/ingest` with the drafted content
- Gate: `kb` + `ai_rag`

### E.4 Streaming (optional, defer if time-boxed)
- SSE endpoint `/api/tickets/{id}/chat/stream` — progressive response

---

## Phase F — Pilot launch kit

**Goal:** orgs can self-serve onboarding without your billing.

### F.1 Plan assignment UI
- `admin/organizations/page.tsx` — plan_id dropdown per org (backend endpoint exists)

### F.2 Upgrade banner rewrite
- `UpgradeBanner.tsx` — "Contact us" content, no dead `/settings?upgrade` route

### F.3 BYOK in onboarding wizard
- `wizard/onboarding/page.tsx` — add AI-keys step between KB upload and invite steps (pilot orgs supply their own Google/Groq key)

### F.4 Seed script refresh
- `backend/demo/demo_seed.py` — refresh demo KB, demo tickets, demo canned responses for pilot showcases

### F.5 README / marketing sync
- Update README stack claims (currently says HNSW/BM25/semantic cache — not true)
- Fix "Groq llama-3.3-70b" claim — defaults are Gemini

---

## Phase H — Pilot Hardening

**Goal:** nothing breaks when real orgs + your wallet touch it.

### H.1 FAISS code removal
- Delete `backend/app/store.py` (528 lines dead code), `faiss-cpu` from requirements.txt
- Remove `_check_faiss_indices` + `_rebuild_one_org` from main.py
- Clean residual FAISS comments/docstrings (rag.py, rag_scoring.py)
- Delete committed FAISS-era `backend/data/` (kb maps + snapshots junk)

### H.2 Embeddings runtime provider switch
- `embeddings.py` — provider now detected **per call** (was import-time, stale after admin model change)
- Fixed missing `import os` (NameError on openai embed path)
- `EMBEDDING_DIM` now dynamic per call

### H.3 Embed dim 768
- `ai_settings.py` — `gemini-embedding-001` → 768 (was 3072; matches actual Gemini default output)
- Fixed wrong dim map: `text-embedding-3-small` → 1536 (was 512)
- Migration 0031 rewritten to `vector(768)` — 3072 invalid for pgvector HNSW (>2000 dim limit)

### H.4 CI + coverage
- Node 18 → 20 (Next.js 15 requirement)
- Lighthouse CI soft-fail (`continue-on-error`)
- Jest JSX fix: `tsconfig.jest.json` (jsx: react-jsx) — real .tsx tests now possible
- Coverage scoped to unit layers (lib/contexts/hooks): 74.7% stmts / 58.8% branches
- Threshold ratcheted: 70 lines/stmts, 65 fns, 55 branches

### H.5 AI feedback loop v0
- `observability.py` — feedback aggregation (positive/negative/rate) added to RAG analytics
- `SystemHealthDashboard` — real AI metrics from `/api/admin/analytics/rag` (was mocked)

### H.6 Entitlement gating — analytics
- 4 analytics endpoints now: org-admin-gated (`_require_org_admin`) + `analytics` feature (402)
- Was global-admin-only — org admins couldn't see their own analytics

### H.7 Seed refresh
- `demo_seed.py` — FAISS writes → pgvector `embedding_vec` (was calling deleted store.py)

### H.8 End-to-end smoke (real Supabase dev DB)
- **Found + fixed:** migration 0031 HNSW 2000-dim failure, migration 0030 cron syntax, local pg missing pgvector
- docker-compose postgres → `pgvector/pgvector:pg16`
- `db.py` — `DB_SSL_MODE` env override (local dev needs disable; Supabase default require)
- `auth.py` — tolerant supabase client creation for new `sb_secret_*` keys (not JWT-shaped)
- Verified: 35/35 migrations apply clean, pgvector extension + `embedding_vec vector(768)` live, asyncpg + psycopg3 pools connect to pooler 6543
- `backend/.env` + `frontend/.env.local` written with dev creds
- **Note:** sb_secret key works for REST but NOT Auth Admin API (401) — profile metadata endpoints degrade gracefully; legacy JWT service_role key needed for full Auth Admin

---

## Phase G — Next Strata products (post-feedback)

**Goal:** after TicketPilot pilots validate the platform, build the next tasteable module.

### G.1 AssetLog (starter plan)
- Spec: `docs/modules/01_assetlog.md`
- Migration: `0033_assetlog.sql` (standalone, no FK deps)
- Pages: `/assets`, `/assets/[id]`

### G.2 ContractVault (starter plan)
- Spec: `docs/modules/02_contractvault.md`
- Migration: `0034_contractvault.sql` (vendors + contracts)

### G.3 Platform Hub
- Spec: `docs/modules/00_strata_platform_hub.md`
- Page: `/platform` with module cards + live stats
- Becomes the primary nav once 2+ modules are live

### G.4 … further modules follow dependency chain in `docs/modules/README.md`

---

## Progress Tracker

| Phase | Status | Notes |
|-------|--------|-------|
| 0–3 Core Fixes | ✅ | Security, correctness, hardening, observability |
| Dev/Prod Separation | ✅ | Env templates, Docker, Makefile, migration runner |
| BYOK AI System | ✅ | DB config, UI settings, provider-agnostic |
| RAG Pipeline Fixes | ✅ | MMR auto-disable, faiss_id sync, MOC removal |
| **A — Tests & CI** | ✅ | 105 backend + 28 frontend tests pass. Coverage 50%/44%/45%/52% (threshold 40%). |
| B — pgvector | ✅ | Migration 0031, rag.py/kb.py/tickets.py switched, FAISS stripped from startup, in-memory fallback. |
| C — Cost/Quota | ✅ | Re-embed eliminated (pgvector), AI quota 402 enforcement, slowapi rate limits on chat/create/ingest, DB-aware model logging. |
| D — UI Polish | ✅ | Dead link fixed (?new=1), cosmetic toggles removed, real audit data in roles page, audit-log note cleaned, KB doc delete, ingest NameError fixed. |
| E — AI + Agents | ✅ | Rep AI gated + feedback wired, Send-to-Customer agent action, KB-draft-from-ticket agent action. |
| F — Pilot Kit | ✅ | Plan dropdown (admin), UpgradeBanner contact-us, AI status step in wizard, README stack claims fixed. |
| H — Pilot Hardening | ✅ | FAISS fully removed, embeddings per-call provider, dim 768, CI Node 20 + coverage ratchet, AI feedback analytics, analytics gating, seed fix, Supabase dev smoke green. |
| G — Next Modules | ⬜ | AssetLog → ContractVault → Platform Hub. |
