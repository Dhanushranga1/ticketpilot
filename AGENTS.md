# Strata

SME IT operations platform — tickets, KB, assets, contracts, procurement, and more. Rebrand of **TicketPilot**: README, frontend, and directories say *Strata*, but backend code, env files, Makefile, and plan.md still say *TicketPilot*. Don't "fix" the branding — it's mid-transition.

## Monorepo layout
- `frontend/` — Next.js 15, React 19, TypeScript, Tailwind, Radix UI, HeroUI
- `backend/` — FastAPI, Python 3.11, asyncpg + psycopg3, FAISS, provider-agnostic AI (Gemini/Groq/OpenAI-compat/Jina)
- No root package.json/lockfile; all JS deps in `frontend/`
- `backend/app/modules/` is **empty** (Strata modules AssetLog/ContractVault/etc. not implemented yet). Specs live in `docs/modules/` — read those before building a new module.
- `docs/` has many guides (`DEPLOYMENT.md`, `CASPER_RAG_RESEARCH.md`, `SECURITY_GUIDE.md`); `plan.md` is the live dev roadmap.

## First-time setup
```bash
make setup     # creates .env files, venv, installs deps
make migrate   # runs pending migrations
make dev       # both servers in parallel
```
Backend env templates: `backend/.env.dev.example` / `.env.prod.example` → `backend/.env`; frontend `frontend/.env.local.example` → `frontend/.env.local`.

## Key commands (make targets)

| Command | What it does |
|---------|-------------|
| `make dev` | Backend (:8000) + frontend (:3000) |
| `make dev-backend` / `make dev-frontend` | Individual servers |
| `make test` | All tests (frontend + backend) |
| `make test-backend` | pytest -v (mocked DB by default) |
| `make test-backend-quick` | pytest -m "not slow" |
| `make test-frontend` | npm test (jest) |
| `make lint` | ESLint + Prettier + Black + isort + mypy + bandit |
| `make format` | Auto-format |
| `make type-check` | tsc --noEmit |
| `make migrate` | Run pending DB migrations |
| `make build` | Frontend production build |
| `make seed` | Demo data (backend must be running) |
| `make docker-up` / `docker-down` | Local Postgres 16 + pgAdmin (:5050) via docker-compose |

**Frontend-only** (CI order: type-check → lint → format:check → build → test):
- `npm run type-check` — tsc --noEmit
- `npm run lint` — next lint
- `npm run format:check` — prettier --check
- `npm run build` — next build
- `npm test` — jest (CI runs `npm test -- --coverage --watchAll=false`, 70% threshold)

**Backend-only**:
- `pytest -v` — all tests; runs against **mocked DB** by default (`backend/tests/conftest.py`). Set `SKIP_MOCK_DB=1` to hit real DB.
- `pytest tests/test_rag_scoring.py -v -s` — single file
- `pytest -m "not slow"` — skip slow (markers: `slow`, `integration`, `unit`; `--strict-markers` on)
- `black --check --diff app/` / `isort --check-only --diff app/` / `mypy app/ --ignore-missing-imports` / `bandit -r app/`
- mypy is **strict**: `disallow_untyped_defs = true` in `backend/pyproject.toml` — new code needs full annotations or `make lint` fails. Black/isort line length 88.

Integration test (both servers running): `python scripts/rag_validation_suite.py` (lives in `scripts/`, not repo root — CI's integration job invokes it from the root, so that CI step is broken).

## Database
- Supabase PostgreSQL, **`app.` schema** (NOT `public`)
- Migrations in `backend/migrations/`, numbered `0001`–`0030` — **auto-apply on startup** via `app/migration_runner.py` (idempotent, tracked in `app.schema_migrations`). No manual SQL Editor step.
- Duplicate numbers exist by design — 0005/0028/0029/0030 each have two files (e.g. `0028_ai_runs_org_id` + `0028_entitlements`). Plus `fixes/` (one-off patches) and `rollback_migrations.sql`.
- Connection uses **transaction pooler** port **6543**, not 5432.

## Auth
- Supabase Auth. Backend verifies JWT — ES256 via JWKS (modern) + HS256 legacy fallback.
- **CRITICAL**: `SUPABASE_JWT_SECRET` = raw signing secret from Settings→API→JWT Settings, NOT the service_role JWT token. Wrong value → `401 Invalid token` on all requests.
- New Supabase projects issue `sb_secret_*`/`sb_publishable_*` API keys (not JWT-shaped). `auth.py` builds the SDK client with a placeholder JWT + real key in Authorization header. **Gotcha**: sb_secret works for REST but NOT Auth Admin API (401) — profile-metadata endpoints degrade gracefully; legacy JWT `service_role` key needed for Auth Admin (invite emails).
- Frontend uses `@supabase/ssr`: cookie sessions (`src/lib/supabase/server.ts` + `client.ts`), route protection + session refresh in `src/middleware.ts` (redirects to `/login?redirect=<path>`). `src/lib/supabaseClient.ts` re-exports the browser client for legacy compat.
- `/invite/[token]` intentionally NOT protected by middleware — page handles unauthenticated visitors itself.
- `/auth/confirm/route.ts` = SSR magic-link verification endpoint.

## Architecture quirks
- Two DB pools: asyncpg `db.py` (async) + psycopg3 `db_sync.py` (sync)
- Two role systems: global `app.user_roles` (admin/rep/customer) + per-org `app.organization_members` (owner/admin/rep/member)
- FAISS index per org on ephemeral filesystem — **wiped on every deploy**, re-upload KB docs
- Org context via `X-Organization-ID` header, processed in `org_middleware.py`; org-scoped routers call `require_org_context`
- DB pool circuit breaker: opens after **3** consecutive failures → 30s cooldown → half-open retry (fast-fail so callers can serve stale cache)
- Background tasks: overdue scan (15 min), pool keepalive (4 min), FAISS rebuild + snapshot load (startup)
- Startup also rebuilds FAISS from embeddings stored in `app.chunks` (snapshot first, fall back to per-vector rebuild)

## Entitlements / plan gating
- New open-core gating: plans `community` / `starter` / `business` / `enterprise` in `backend/app/entitlements/plans.py`
- Backend: `entitlements_router.py` (`GET /api/entitlements`), gated features return 402 when plan doesn't include them
- Frontend: `useEntitlements` hook (`src/hooks/useEntitlements.ts`) + `src/lib/plans.ts` — **gate new UI behind entitlements, not hardcoded checks**

## RAG / AI pipeline
- 2400 char chunks, 400 overlap → embed → FAISS `IndexFlatIP` per org → MMR re-ranking (auto-disabled when KB < 50 chunks) → LLM with structured JSON → CASPER confidence scoring (intent-adaptive, KB-density-calibrated)
- **AI is provider-agnostic** (`app/ai.py`, `app/embeddings.py`): provider auto-detected from model name prefix (`gemini-*` → Google, `claude-*` → Anthropic, else OpenAI-compat/Groq; embeddings: google/openai/jina)
- Model + API keys are **runtime-configurable**: DB `app.ai_settings` (single row, `LIMIT 1`, global) overrides env, editable via admin UI `/admin/settings/ai` (BYOK). Defaults: `gemini-2.0-flash`, `gemini-embedding-001` (3072-dim). Clear `invalidate_cache()` if you change the table directly
- Tuning env: `RAG_TOP_K` (6), `RAG_MIN_SCORE` (0.25), `RAG_MAX_CONTEXT_CHARS` (12000), `MMR_LAMBDA` (0.7), `CONFIDENCE_THRESHOLD` (0.55), `CONFIDENCE_MIN_CHUNKS` (2)
- `app/redact.py` scrubs PII from context before it reaches the LLM

## Deployment
- Frontend → Vercel: `npm run build`, output `.next`
- Backend → Render (`render.yaml`): `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Env var name is `NEXT_PUBLIC_API_URL` (not `_API_BASE`)
- `WEB_ORIGIN` = exact frontend URL, no trailing slash (comma-separated list supported via `CORS_ORIGINS`)
- Migrations auto-apply on startup — no manual step needed
- Local self-host: `infra/docker-compose.yml` (backend + frontend + nginx)

## Gotchas
- CI workflow `.github/workflows/ci-development.yml` sets **stale env var names** for backend tests: `SUPABASE_SERVICE_KEY` and `JWT_SECRET`. Code reads `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_JWT_SECRET`. Backend tests still pass because conftest.py sets the correct names + mocks Supabase; don't rely on CI's vars for real runs.
- `organizations.py.backup` in `backend/app/` is committed junk — ignore it.
- Pre-deploy: FAISS indices wiped on redeploy → re-upload KB docs; `SUPABASE_SERVICE_ROLE_KEY` required for invite emails (otherwise invite links returned in response body).

## Frontend conventions
- `@/` alias → `src/` (tsconfig.json + next.config.ts webpack alias + jest moduleNameMapper)
- `next.config.ts` sets `typescript.ignoreBuildErrors` + `eslint.ignoreDuringBuilds` — **`npm run build` will NOT catch type/lint errors**; always run `npm run type-check` and `npm run lint` separately
- `next.config.ts` transpiles `@heroui/react` + `@heroui/theme` (prevents duplicate framer-motion → ChunkLoadError)
- API via `src/lib/api-client.ts` (auto-auth, 30s GET cache with prefix invalidation, retry 502/503 on cold-start)
- Prettier: single quotes, no trailing comma in func params, 80 width
- ESLint: next/core-web-vitals + next/typescript
- Route groups: `src/app/(protected)/` = authed pages, `(public)/`, `(marketing)/`, `(wizard)/`
