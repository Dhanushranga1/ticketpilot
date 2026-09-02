# Strata — Executive Summary

## What It Is

**Strata** is a complete IT operations platform for small and medium enterprises (SMEs). It replaces the fragmented toolchain — separate ticketing, asset, contract, procurement, and service-desk products — with a single, AI-first, open-core platform built for IT teams of 1–10 people managing 50–500 employees.

The ticket engine, knowledge base, and AI assistant ship first; the broader IT operations modules are released as the platform expands.

## The Problem

SMEs run IT on a patchwork of disconnected tools and spreadsheets: a helpdesk for tickets, a manual asset register, contracts scattered in email, and no structured procurement or change process. Nothing talks to anything else, and nothing learns from the organization's own documentation. IT teams spend their time switching tools and re-entering data instead of resolving issues.

## The Solution

Strata unifies the full IT operations lifecycle on one platform:

| Module | What it does |
|--------|-------------|
| **TicketPilot** | AI-assisted support tickets, SLA tracking, canned responses, CSAT |
| **KnowBase** | Searchable knowledge articles with FAISS-backed AI retrieval |
| **AssetLog** | Hardware/software inventory, QR codes, warranty alerts |
| **ContractVault** | Vendor directory, contract renewals, document links |
| **ProcureFlow** | Purchase requests → approvals → delivery → AssetLog |
| **ServiceHub** | Employee self-service portal, dynamic request forms |
| **PatchWatch** | Patch status by asset and severity, maintenance windows |
| **CostLens** | Unused licenses, idle assets, renewal forecasts |
| **ChangeBoard** | RFC workflow, blackout periods, change calendar |
| **IncidentBridge** | P1 war room, live timeline, stakeholder comms |
| **FlowBot** | IF/THEN automation rules engine for ticket workflows |
| **StatusCast** | Public status page, auto-updated by IncidentBridge |
| **PeopleSync** | Joiner/Mover/Leaver IT checklists, HR webhook integration |

TicketPilot (core) is implemented and shipping; the remaining modules are on the roadmap with full specs in `docs/modules/`.

## Key Differentiators

- **AI-first, grounded in your own data.** The CASPER AI assistant answers from the organization's own knowledge base via a RAG pipeline — chunked docs embedded and searched with FAISS, re-ranked, then generated with citations and confidence scoring. It escalates to a human when confidence is low.
- **BYOK AI.** Model and API keys are runtime-configurable in the admin UI, not hardcoded. The AI layer is provider-agnostic — Gemini, Claude, Groq, or any OpenAI-compatible endpoint — so customers bring their own keys.
- **Multi-tenant by design.** Strict per-organization data isolation, org scoping on every request, and role systems at both the platform and organization level.
- **Open-core monetization.** Community plan is free; Starter, Business, and Enterprise unlock AI, KB, advanced modules, and analytics. Feature gating is enforced end-to-end.

## Architecture

- **Backend:** FastAPI (Python 3.11), asyncpg + psycopg3, provider-agnostic AI layer, FAISS vector search, Supabase Postgres (transaction-pooler) for storage and JWT auth.
- **Frontend:** Next.js 15, React 19, TypeScript, Tailwind, Radix UI + HeroUI.
- **Deployment:** Backend on Render, frontend on Vercel; migrations auto-apply on startup; self-hostable via Docker Compose.
- **Security:** JWT auth, RLS on the database, PII scrubbing before the LLM, rate limiting, audit logging, and per-org data isolation.

## Current Status

- Core platform (tickets, KB, AI assistant, SLA, orgs, invites, reports, notifications, entitlements) implemented and passing CI — type check, lint, format, build, tests on both frontend and backend.
- Entering the open-core product phase: entitlements and plan gating are in place, and the Strata module suite (asset, contract, procurement, etc.) is next on the roadmap.

## Target Market

SMEs (50–500 employees) with lean IT teams who need enterprise-grade IT operations without enterprise budgets or complexity. Sellable per-seat via self-serve or admin-led onboarding, with the AI knowledge base as the wedge feature and the asset/procurement suite as the expansion path.
