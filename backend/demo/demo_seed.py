"""
Demo seed — uploads KB doc and creates two demo tickets directly via
internal modules (no HTTP). Run from the backend/ directory:

    python demo_seed.py
"""

import os, sys, json, uuid
from pathlib import Path

# Load env before importing modules
from dotenv import load_dotenv
load_dotenv()

import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.getenv("DATABASE_URL")
ORG_ID   = "050f64b5-d575-43db-9b0e-6fdd38f74bae"   # ventura_demo
ADMIN_ID = "cfa54340-eea2-43af-b0fd-6cc11ea68b5f"    # dg1513@srmist.edu.in (owner)
CUSTOMER_ID = "912ee847-2a27-4388-8e8b-3a38edcbc9c3" # anaya.purohit09@gmail.com

KB_FILE  = Path(__file__).parent.parent / "rag_test_kb.md"


def db():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=15)


# ─────────────────────────────────────────────────────────────────────────────
# 1. KB ingest
# ─────────────────────────────────────────────────────────────────────────────

def ingest_kb():
    from app.utils import normalize_text, sha256
    from app.chunker import make_chunks
    from app.embeddings import embed_texts

    print("[KB] Reading", KB_FILE)
    raw_text = KB_FILE.read_text()
    text = normalize_text(raw_text)
    doc_hash = sha256(text)
    size_bytes = len(raw_text.encode())

    CHUNK_SIZE = int(os.getenv("CHUNK_SIZE_CHARS", "2400"))
    OVERLAP    = int(os.getenv("CHUNK_OVERLAP_CHARS", "400"))

    with db() as conn:
        cur = conn.cursor()

        # Dedup by hash — but if doc exists with no chunks, continue to chunk insertion
        cur.execute("SELECT id FROM app.documents WHERE doc_hash = %s AND organization_id = %s",
                    (doc_hash, ORG_ID))
        existing = cur.fetchone()
        if existing:
            doc_id = str(existing["id"])
            cur.execute("SELECT COUNT(*) AS c FROM app.chunks WHERE organization_id = %s", (ORG_ID,))
            chunk_count = cur.fetchone()['c']
            if chunk_count > 0:
                print(f"[KB] Already ingested ({chunk_count} chunks) — skipping.")
                return
            print(f"[KB] Doc exists (id={doc_id}) but no chunks — inserting chunks.")
        else:
            cur.execute("""
                INSERT INTO app.documents (organization_id, title, source, mime_type, size_bytes, doc_hash, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (ORG_ID, "TicketPilot Support Knowledge Base", "upload:rag_test_kb.md",
                  "text/markdown", size_bytes, doc_hash, ADMIN_ID))
            doc_id = str(cur.fetchone()["id"])
            conn.commit()

    print(f"[KB] doc_id={doc_id}")

    # Chunk
    chunks = make_chunks(text, CHUNK_SIZE, OVERLAP)
    print(f"[KB] Chunked into {len(chunks)} pieces")

    # Embed
    print("[KB] Generating embeddings …")
    vectors = embed_texts(chunks)
    print(f"[KB] Embedded {len(vectors)} chunks")

    # Insert chunks (without embeddings first, like kb.py does)
    with db() as conn:
        cur = conn.cursor()
        chunk_ids = []
        for i, chunk_text in enumerate(chunks):
            chunk_hash = sha256(chunk_text)
            token_count = len(chunk_text.split())
            cur.execute("""
                INSERT INTO app.chunks (doc_id, chunk_index, text, chunk_hash, token_count, organization_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (doc_id, i, chunk_text, chunk_hash, token_count, ORG_ID))
            chunk_ids.append(str(cur.fetchone()["id"]))
        conn.commit()

    print(f"[KB] Inserted {len(chunk_ids)} chunks")

    # Write embeddings to pgvector column
    with db() as conn:
        cur = conn.cursor()
        for chunk_id, vec in zip(chunk_ids, vectors):
            cur.execute(
                "UPDATE app.chunks SET embedding_vec = %s::vector, embedding = %s::float4[] WHERE id = %s",
                (str(list(vec)), list(vec), chunk_id),
            )
        conn.commit()

    print(f"[KB] Done — {len(chunk_ids)} chunks in DB with pgvector embeddings")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Create tickets + messages
# ─────────────────────────────────────────────────────────────────────────────

def create_ticket(title: str, body: str, priority_label: str) -> str:
    priority_map = {"low": 6, "medium": 4, "high": 2, "critical": 1}
    prio_level = priority_map.get(priority_label, 4)

    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app.tickets
              (organization_id, created_by, title, status, priority, priority_level)
            VALUES (%s, %s, %s, 'open', %s, %s)
            RETURNING id
        """, (ORG_ID, CUSTOMER_ID, title, priority_label, prio_level))
        ticket_id = str(cur.fetchone()["id"])

        # Initial customer message
        cur.execute("""
            INSERT INTO app.messages (ticket_id, organization_id, sender_id, sender_role, body)
            VALUES (%s, %s, %s, 'customer', %s)
        """, (ticket_id, ORG_ID, CUSTOMER_ID, body))

        # Increment message count
        cur.execute("UPDATE app.tickets SET message_count=1 WHERE id=%s", (ticket_id,))
        conn.commit()

    print(f"[TICKET] Created {ticket_id[:8]}…  '{title}'")
    return ticket_id


def add_ai_message(ticket_id: str, body: str, confidence: float,
                   suggest_escalation: bool, citations: list):
    meta = {
        "confidence": confidence,
        "suggest_escalation": suggest_escalation,
        "citations": citations,
        "model": os.getenv("GENAI_MODEL", "gemini-1.5-pro"),
    }
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app.messages
              (ticket_id, organization_id, sender_id, sender_role, body, meta)
            VALUES (%s, %s, %s, 'ai', %s, %s)
            RETURNING id
        """, (ticket_id, ORG_ID, CUSTOMER_ID, body, json.dumps(meta)))
        msg_id = str(cur.fetchone()["id"])
        cur.execute("""
            UPDATE app.tickets
            SET message_count = message_count + 1,
                last_message_at = NOW(),
                updated_at = NOW()
            WHERE id = %s
        """, (ticket_id,))
        conn.commit()
    return msg_id


def add_system_escalation_note(ticket_id: str):
    body = "[system] AI escalation: Insufficient knowledge base context to answer reliably (confidence 0.18). Assigned to human rep."
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app.messages
              (ticket_id, organization_id, sender_id, sender_role, body)
            VALUES (%s, %s, %s, 'system', %s)
        """, (ticket_id, ORG_ID, CUSTOMER_ID, body))
        # Escalate the ticket status
        cur.execute("""
            UPDATE app.tickets SET status='escalated', escalated_at=NOW(),
            escalated_to=%s WHERE id=%s
        """, (ADMIN_ID, ticket_id))
        conn.commit()
    print(f"[TICKET] Ticket {ticket_id[:8]}… escalated to admin")


def add_rep_reply(ticket_id: str, body: str):
    with db() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app.messages
              (ticket_id, organization_id, sender_id, sender_role, body)
            VALUES (%s, %s, %s, 'rep', %s)
        """, (ticket_id, ORG_ID, ADMIN_ID, body))
        cur.execute("""
            UPDATE app.tickets
            SET message_count = message_count + 1,
                last_message_at = NOW(),
                status = 'in_progress',
                assignee_id = %s
            WHERE id = %s
        """, (ADMIN_ID, ticket_id))
        conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Step 1 — KB
    print("\n═══ STEP 1: KB Ingest ═══")
    ingest_kb()

    # Step 2 — Ticket A: password reset → AI RESOLVES
    print("\n═══ STEP 2: Ticket A (AI resolves) ═══")
    tid_a = create_ticket(
        title="Can't log in — forgot my password",
        body=(
            "Hi team,\n\n"
            "I've been locked out of my account since this morning. "
            "I tried logging in but can't remember my password. "
            "How do I reset it? Does the reset link have an expiry time? "
            "Also I'm not seeing the email — could it be in spam?\n\n"
            "Thanks"
        ),
        priority_label="medium",
    )

    # Simulate the AI response (what CASPER would say — grounded in KB)
    ai_answer_a = (
        "I can help with that! Here's how to reset your password:\n\n"
        "1. Go to the **login page** and click **\"Forgot password\"**.\n"
        "2. Enter your registered email address.\n"
        "3. You'll receive a password reset link **within 2 minutes** — "
        "check your spam/junk folder if you don't see it.\n"
        "4. **The link expires after 30 minutes**, so use it promptly.\n\n"
        "If you've done all of this and still can't access your account, "
        "please contact support at **help@ticketpilot.io** and we'll sort it out.\n\n"
        "Hope that helps! 😊"
    )
    add_ai_message(
        tid_a, ai_answer_a,
        confidence=0.87,
        suggest_escalation=False,
        citations=[
            {"source": "rag_test_kb.md", "section": "Account & Billing — How do I reset my password?"},
        ],
    )
    print(f"[AI] Added high-confidence AI response to Ticket A (confidence=0.87)")

    # Step 3 — Ticket B: Salesforce OAuth → AI ESCALATES
    print("\n═══ STEP 3: Ticket B (AI escalates) ═══")
    tid_b = create_ticket(
        title="Salesforce two-way sync breaks after OAuth token expiry",
        body=(
            "Hi,\n\n"
            "We have TicketPilot connected to Salesforce using a custom OAuth2 app. "
            "Every 90 days the SFDC access token expires silently and the two-way sync stops — "
            "new tickets don't appear in our CRM and CRM updates don't reflect here.\n\n"
            "There's no alert or error in the TicketPilot dashboard when this happens. "
            "We need either:\n"
            "  a) Automatic token refresh before expiry, or\n"
            "  b) A webhook/email alert when the sync connection drops.\n\n"
            "Our Salesforce instance is in the EU data centre (EU15 pod). "
            "Is there a known fix or timeline for this?\n\n"
            "Regards,\nAnaya"
        ),
        priority_label="high",
    )

    ai_answer_b = (
        "Thank you for reaching out. I searched our knowledge base for information about "
        "Salesforce OAuth token refresh and EU data centre sync configurations, but I don't "
        "have enough documentation to give you a reliable answer on this specific issue.\n\n"
        "**I'm escalating this to a human support rep** who will be able to:\n"
        "- Check our Salesforce integration roadmap for automatic token refresh\n"
        "- Advise on EU15 pod-specific configuration\n"
        "- Set up a webhook alert for sync failures\n\n"
        "You should hear back within **12 hours** (P2 SLA). Apologies for the inconvenience."
    )
    add_ai_message(
        tid_b, ai_answer_b,
        confidence=0.18,
        suggest_escalation=True,
        citations=[],
    )
    add_system_escalation_note(tid_b)
    print(f"[AI] Added low-confidence AI response to Ticket B (confidence=0.18), escalated")

    # Add rep reply on Ticket B to show the workflow
    add_rep_reply(
        tid_b,
        "Hi Anaya,\n\n"
        "Thanks for the detailed report. You're right that we don't currently have automatic "
        "OAuth token refresh for Salesforce — this is a known limitation and is on our Q3 roadmap.\n\n"
        "As a workaround right now:\n"
        "1. Set a calendar reminder to re-authenticate in Settings → Integrations → Salesforce every 85 days.\n"
        "2. I'll flag your account for our engineering team to prioritise the EU15 fix.\n\n"
        "I'll follow up once the auto-refresh feature ships. Sorry for the disruption!\n\n"
        "— Dhanu (Support)"
    )
    print(f"[REP] Added rep reply to Ticket B")

    # Summary
    print(f"""
════════════════════════════════════════════════════
  DEMO SETUP COMPLETE
════════════════════════════════════════════════════
  Org:      ventura_demo  ({ORG_ID})

  Ticket A: {tid_a}
            "Can't log in — forgot my password"
            AI RESOLVED  (confidence 0.87)  ← show this first

  Ticket B: {tid_b}
            "Salesforce two-way sync breaks…"
            AI ESCALATED (confidence 0.18)  ← then show this
            Rep replied → status=in_progress

  KB docs:  rag_test_kb.md uploaded to ventura_demo

  Log in as dg1513@srmist.edu.in, switch to ventura_demo org,
  and open the Rep Queue / Admin Panel to see both tickets.
════════════════════════════════════════════════════
""")
