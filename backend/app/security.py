"""Prototype auth: local email + password with PBKDF2 hashing and HS256 JWTs.

The `get_current_user` dependency is the single seam the whole API depends on, so
swapping in Entra ID / Auth0 later means validating an OIDC token here and mapping
the `sub`/`email` claim onto a User row -- no route changes required.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import Role, User, has_rank, outranks, role_label, roles_high_to_low

_ITERATIONS = 120_000
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, iterations, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), digest_hex)


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role.value,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.jwt_expire_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = jwt.decode(
            creds.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from None

    user = db.get(User, payload.get("sub"))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer active")
    return user


def require_rank(floor: Role):
    """Gate a route on the role hierarchy rather than on a set of role names."""

    def _dep(user: User = Depends(get_current_user)) -> User:
        if not has_rank(user.role, floor):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"Requires {role_label(floor)} or above"
            )
        return user

    return _dep


# The floors, named for what they protect rather than for who currently clears them.
EDITOR_FLOOR = Role.MANAGER       # changing purchase orders, and attaching files to them
# Status and stage (kanban column) moves on an unlocked order. Narrower than
# EDITOR_FLOOR: a User may PATCH only those fields; create/delete/arbitrary
# edits still need Manager+.
STATUS_FLOOR = Role.USER
PEOPLE_FLOOR = Role.MANAGER       # inviting people, setting their roles, reading the directory
LOCKED_PO_FLOOR = Role.ADMIN      # working through a locked order, unlocking included
# Your own name and photo are yours at every rank. Written as a floor rather than
# as "no check" so it stays inside the same system: if a rung is ever added below
# Viewer, this line is where you decide whether it keeps self-service.
SELF_PHOTO_FLOOR = Role.VIEWER

require_admin = require_rank(Role.ADMIN)
require_editor = require_rank(EDITOR_FLOOR)
require_status = require_rank(STATUS_FLOOR)
require_people_admin = require_rank(PEOPLE_FLOOR)
require_self_photo = require_rank(SELF_PHOTO_FLOOR)


def assert_may_manage(actor: User, target: User) -> None:
    """You may only act on someone strictly below you. Admins are exempt.

    Without this, widening people-administration to Manager would let a Manager
    demote an Admin, or edit a peer, and so hand themselves the whole install.
    """
    if actor.role is Role.ADMIN or outranks(actor.role, target.role):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"You can only manage people below {role_label(actor.role)}",
    )


def assert_may_assign(actor: User, role: Role) -> None:
    """You may only hand out a role strictly below your own. Admins are exempt."""
    if actor.role is Role.ADMIN or outranks(actor.role, role):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"You can only assign roles below {role_label(actor.role)}",
    )


def assignable_roles(actor: User) -> list[Role]:
    """What the actor's role picker should offer, most authority first."""
    if actor.role is Role.ADMIN:
        return roles_high_to_low()
    return [r for r in roles_high_to_low() if outranks(actor.role, r)]
