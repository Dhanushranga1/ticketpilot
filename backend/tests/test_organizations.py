"""
Tests for backend/app/organizations.py — org CRUD, slug validation,
member management, permission checks.

All tests use mocked DB; no real PostgreSQL required.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.organizations import (
    check_slug_available,
    generate_slug_from_name,
    get_user_role_in_org,
    validate_slug,
    verify_org_permission,
)

from tests.conftest import TEST_ORG_ID, TEST_USER_ID, MockCursor, MockConn


# ═════════════════════════════════════════════════════════════════════════
# validate_slug — pure function
# ═════════════════════════════════════════════════════════════════════════


class TestValidateSlug:
    def test_valid_slug(self):
        assert validate_slug("acme-corp") == "acme-corp"

    def test_valid_slug_single_word(self):
        assert validate_slug("acme") == "acme"

    def test_valid_slug_with_numbers(self):
        assert validate_slug("acme-2024") == "acme-2024"

    def test_strips_whitespace_and_lowercases(self):
        assert validate_slug("  Acme-Corp  ") == "acme-corp"

    def test_empty_slug_raises(self):
        with pytest.raises(HTTPException) as exc:
            validate_slug("")
        assert exc.value.status_code == 400

    def test_too_short_raises(self):
        with pytest.raises(HTTPException) as exc:
            validate_slug("ab")
        assert exc.value.status_code == 400

    def test_too_long_raises(self):
        with pytest.raises(HTTPException) as exc:
            validate_slug("a" * 51)
        assert exc.value.status_code == 400

    def test_invalid_characters_raises(self):
        for bad in ("Acme_Corp", "acme corp", "acme.corp", "Acme!", "acme--corp"):
            with pytest.raises(HTTPException):
                validate_slug(bad)

    def test_reserved_slugs_raise(self):
        for reserved in ("api", "admin", "auth", "login", "signup", "docs", "health"):
            with pytest.raises(HTTPException) as exc:
                validate_slug(reserved)
            assert exc.value.status_code == 400

    def test_reserved_case_insensitive(self):
        """validate_slug lowercases before checking."""
        for reserved in ("API", "Admin", "AUTH"):
            with pytest.raises(HTTPException):
                validate_slug(reserved)


# ═════════════════════════════════════════════════════════════════════════
# generate_slug_from_name — pure function
# ═════════════════════════════════════════════════════════════════════════


class TestGenerateSlugFromName:
    def test_simple_name(self):
        assert generate_slug_from_name("Acme Corp") == "acme-corp"

    def test_strips_special_chars(self):
        assert generate_slug_from_name("Acme & Sons!") == "acme-sons"

    def test_collapses_multiple_hyphens(self):
        assert generate_slug_from_name("Acme --- Corp") == "acme-corp"

    def test_strips_leading_trailing_hyphens(self):
        assert generate_slug_from_name("--Acme--") == "acme"

    def test_short_name_gets_suffix(self):
        result = generate_slug_from_name("AB")
        assert len(result) >= 3
        assert result == "ab-org"

    def test_long_name_truncated(self):
        result = generate_slug_from_name("A" * 100)
        assert len(result) <= 50

    def test_numbers_preserved(self):
        assert generate_slug_from_name("Acme 2024") == "acme-2024"


# ═════════════════════════════════════════════════════════════════════════
# get_user_role_in_org — DB-mocked
# ═════════════════════════════════════════════════════════════════════════


class TestGetUserRoleInOrg:
    def test_returns_role_when_member(self):
        conn = MockConn(rows=[{"role": "admin"}])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            role = get_user_role_in_org(TEST_USER_ID, TEST_ORG_ID)
        assert role == "admin"

    def test_returns_none_when_not_member(self):
        conn = MockConn(rows=[])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            role = get_user_role_in_org(TEST_USER_ID, TEST_ORG_ID)
        assert role is None


# ═════════════════════════════════════════════════════════════════════════
# verify_org_permission — DB-mocked
# ═════════════════════════════════════════════════════════════════════════


class TestVerifyOrgPermission:
    def test_valid_role_passes(self):
        conn = MockConn(rows=[{"role": "admin"}])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            # Should not raise
            verify_org_permission(TEST_USER_ID, TEST_ORG_ID, ["admin", "owner"])

    def test_not_member_raises_404(self):
        conn = MockConn(rows=[])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            with pytest.raises(HTTPException) as exc:
                verify_org_permission(
                    TEST_USER_ID, TEST_ORG_ID, ["admin", "owner"]
                )
        assert exc.value.status_code == 404

    def test_insufficient_role_raises_403(self):
        conn = MockConn(rows=[{"role": "member"}])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            with pytest.raises(HTTPException) as exc:
                verify_org_permission(
                    TEST_USER_ID, TEST_ORG_ID, ["admin", "owner"]
                )
        assert exc.value.status_code == 403


# ═════════════════════════════════════════════════════════════════════════
# check_slug_available — DB-mocked
# ═════════════════════════════════════════════════════════════════════════


class TestCheckSlugAvailable:
    def test_available_slug(self):
        conn = MockConn(rows=[])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            assert check_slug_available("new-slug") is True

    def test_reserved_slug_unavailable(self):
        """First cursor.execute (reserved_slugs) returns a row."""
        conn = MockConn(rows=[{"exists": 1}])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ):
            assert check_slug_available("admin") is False

    def test_existing_org_unavailable(self):
        """First cursor (reserved) returns None, second (orgs) returns a row."""
        # MockConn returns same rows for all cursor calls — need a custom cursor
        class MultiCursor:
            def __init__(self):
                self._call = 0

            def execute(self, q, p=None):
                return self

            def fetchone(self):
                self._call += 1
                if self._call == 1:
                    return None  # reserved_slugs: not found
                return {"exists": 1}  # organizations: found

        class MultiConn:
            def cursor(self):
                return MultiCursor()

            def commit(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

        with patch(
            "app.organizations.get_db_connection", return_value=MultiConn()
        ):
            assert check_slug_available("taken-slug") is False


# ═════════════════════════════════════════════════════════════════════════
# Endpoint integration tests via async_client
# ═════════════════════════════════════════════════════════════════════════


class TestCreateOrganizationEndpoint:
    """Test POST /api/organizations endpoint flow."""

    @pytest.mark.asyncio
    async def test_create_org_valid_slug(self, async_client, jwt_admin):
        """Valid org creation returns 201 + org data."""
        mock_org_row = {
            "id": TEST_ORG_ID,
            "name": "Acme Corp",
            "slug": "acme-corp",
            "domain": None,
            "settings": {},
            "is_active": True,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "plan_id": "community",
        }

        conn = MockConn(rows=[mock_org_row])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ), patch(
            "app.organizations.check_slug_available", return_value=True
        ), patch(
            "app.roles.get_user_role", new=__import__("unittest.mock", fromlist=["AsyncMock"]).AsyncMock(return_value="admin")
        ):
            resp = await async_client.post(
                "/api/organizations",
                json={"name": "Acme Corp", "slug": "acme-corp"},
                headers={"Authorization": f"Bearer {jwt_admin}"},
            )

        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Acme Corp"
        assert data["slug"] == "acme-corp"

    @pytest.mark.asyncio
    async def test_create_org_reserved_slug(self, async_client, jwt_admin):
        """Reserved slug rejected with 409."""
        with patch(
            "app.organizations.check_slug_available", return_value=False
        ), patch(
            "app.roles.get_user_role", new=__import__("unittest.mock", fromlist=["AsyncMock"]).AsyncMock(return_value="admin")
        ):
            resp = await async_client.post(
                "/api/organizations",
                json={"name": "Admin Panel", "slug": "admin"},
                headers={"Authorization": f"Bearer {jwt_admin}"},
            )

        # validate_slug raises 400 before we even check availability
        # But "admin" IS in the reserved list, so validate_slug catches it first
        assert resp.status_code in (400, 409)

    @pytest.mark.asyncio
    async def test_create_org_auto_slug(self, async_client, jwt_admin):
        """When slug not provided, auto-generated from name."""
        mock_org_row = {
            "id": TEST_ORG_ID,
            "name": "Acme Corp",
            "slug": "acme-corp",
            "domain": None,
            "settings": {},
            "is_active": True,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
            "plan_id": "community",
        }

        conn = MockConn(rows=[mock_org_row])
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ), patch(
            "app.organizations.check_slug_available", return_value=True
        ), patch(
            "app.roles.get_user_role", new=__import__("unittest.mock", fromlist=["AsyncMock"]).AsyncMock(return_value="admin")
        ):
            resp = await async_client.post(
                "/api/organizations",
                json={"name": "Acme Corp"},
                headers={"Authorization": f"Bearer {jwt_admin}"},
            )

        assert resp.status_code == 201
        assert resp.json()["slug"] == "acme-corp"


class TestListOrganizationsEndpoint:
    """Test GET /api/organizations returns user's orgs."""

    @pytest.mark.asyncio
    async def test_list_orgs(self, async_client, jwt_admin):
        mock_rows = [
            {
                "id": TEST_ORG_ID,
                "name": "Acme Corp",
                "slug": "acme-corp",
                "domain": None,
                "settings": {},
                "is_active": True,
                "created_at": "2025-01-01T00:00:00Z",
                "updated_at": "2025-01-01T00:00:00Z",
                "member_count": 5,
                "your_role": "admin",
                "plan_id": "community",
            }
        ]

        conn = MockConn(rows=mock_rows)
        with patch(
            "app.organizations.get_db_connection", return_value=conn
        ), patch(
            "app.roles.get_user_role", new=__import__("unittest.mock", fromlist=["AsyncMock"]).AsyncMock(return_value="admin")
        ):
            resp = await async_client.get(
                "/api/organizations",
                headers={"Authorization": f"Bearer {jwt_admin}"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["name"] == "Acme Corp"


# ═════════════════════════════════════════════════════════════════════════
# Pydantic schema validation
# ═════════════════════════════════════════════════════════════════════════


class TestPydanticSchemas:
    def test_org_create_min_name_length(self):
        from app.organizations import OrganizationCreate

        # min_length=2
        with pytest.raises(Exception):
            OrganizationCreate(name="A")

    def test_org_create_valid(self):
        from app.organizations import OrganizationCreate

        org = OrganizationCreate(name="Acme Corp")
        assert org.name == "Acme Corp"
        assert org.slug is None

    def test_member_add_valid_roles(self):
        from app.organizations import OrganizationMemberAdd

        for role in ("owner", "admin", "rep", "member"):
            m = OrganizationMemberAdd(user_id=TEST_USER_ID, role=role)
            assert m.role == role

    def test_member_add_invalid_role(self):
        from app.organizations import OrganizationMemberAdd

        with pytest.raises(Exception):
            OrganizationMemberAdd(user_id=TEST_USER_ID, role="superadmin")

    def test_member_update_valid_roles(self):
        from app.organizations import OrganizationMemberUpdate

        for role in ("owner", "admin", "rep", "member"):
            m = OrganizationMemberUpdate(role=role)
            assert m.role == role

    def test_member_update_invalid_role(self):
        from app.organizations import OrganizationMemberUpdate

        with pytest.raises(Exception):
            OrganizationMemberUpdate(role="guest")
