from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..models import Activity, Role, User, has_rank, role_label
from ..schemas import ActivityOut, Assignee, UserCreate, UserOut, UserUpdate
from ..security import (
    PEOPLE_FLOOR,
    assert_may_assign,
    assert_may_manage,
    get_current_user,
    hash_password,
    require_admin,
    require_editor,
    require_people_admin,
)

router = APIRouter(prefix="/api/users", tags=["users"])


# What anyone, at any rank, may change about their *own* record. Everything else
# (role, org, is_active, is_pending, password) is an administrative act and goes
# through the rank checks below.
SELF_SERVICE_FIELDS = {"avatar_url", "name"}


def _clean_org(org: str | None) -> str | None:
    """Blank input means "no org" rather than an empty-string org."""
    cleaned = (org or "").strip()
    return cleaned or None


def _assert_may_read(actor: User, user_id: str) -> None:
    """Reading a person's record: your own is always yours, anyone else's is directory data.

    Gating the list without this would only make enumeration less convenient --
    ids come back on every purchase order's `owner`, so a by-id read left open to
    everyone still hands over the addresses. Checked before the row is loaded, so
    a refusal doesn't double as an "account exists" oracle.
    """
    if actor.id == user_id or has_rank(actor.role, PEOPLE_FLOOR):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        f"{role_label(PEOPLE_FLOOR)} or above reads other people's accounts",
    )


def _usable_admins(db: Session, *, excluding: str | None = None) -> int:
    """Admins who can actually sign in — disabled and never-accepted invites don't count."""
    stmt = select(func.count()).select_from(User).where(
        User.role == Role.ADMIN,
        User.is_active.is_(True),
        User.is_pending.is_(False),
    )
    if excluding:
        stmt = stmt.where(User.id != excluding)
    return db.scalar(stmt) or 0


def _locks_out_admins(db: Session, user: User, changes: dict) -> bool:
    """Would applying `changes` leave the install with nobody able to administer it?"""
    was_usable_admin = user.role == Role.ADMIN and user.is_active and not user.is_pending
    if not was_usable_admin:
        return False

    still_admin = (
        changes.get("role", user.role) == Role.ADMIN
        and changes.get("is_active", user.is_active)
        and not changes.get("is_pending", user.is_pending)
    )
    if still_admin:
        return False

    return _usable_admins(db, excluding=user.id) == 0


@router.get("", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_people_admin),
    q: str | None = Query(None),
    role: Role | None = None,
) -> list[User]:
    """The full directory: every account's email, role and sign-in state.

    Restricted to the ranks that administer accounts. It used to depend only on
    `get_current_user`, which let anyone who self-registered enumerate every
    address in the shop. Anyone who merely needs names to hand work to should use
    `/assignable`, which carries no email.
    """
    stmt = select(User)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.name.ilike(like), User.email.ilike(like)))
    if role:
        stmt = stmt.where(User.role == role)
    return list(db.scalars(stmt.order_by(User.name)))


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate, db: Session = Depends(get_db), actor: User = Depends(require_people_admin)
) -> User:
    # An invite hands out a role, so it obeys the same ceiling as changing one:
    # nobody can conjure a peer or a superior into existence.
    assert_may_assign(actor, payload.role)

    email = payload.email.lower().strip()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "A user with that email already exists")

    user = User(
        email=email,
        name=payload.name,
        org=_clean_org(payload.org),
        role=payload.role,
        avatar_url=payload.avatar_url,
        password_hash=hash_password(payload.password) if payload.password else None,
        is_pending=payload.password is None,
    )
    db.add(user)
    db.flush()
    db.add(
        Activity(
            actor_id=actor.id,
            action="User invited",
            entity_type="user",
            entity_id=user.id,
            detail=f"{user.email} · {user.role.value}",
        )
    )
    db.commit()
    db.refresh(user)
    return user


@router.get("/orgs", response_model=list[str])
def list_orgs(db: Session = Depends(get_db), _: User = Depends(require_people_admin)) -> list[str]:
    """Orgs already in use, so the picker can suggest them instead of inviting typos.

    Only the invite form and the org field feed on this, and both are people
    administration now, so it sits on the same floor as the directory rather than
    handing out a roster of company names to anyone who signs up.
    """
    return sorted(db.scalars(select(User.org).where(User.org.is_not(None)).distinct()))


@router.get("/assignable", response_model=list[Assignee])
def list_assignable(
    db: Session = Depends(get_db), _: User = Depends(require_editor)
) -> list[User]:
    """Who an order can be assigned to.

    Declared above `/{user_id}` so the literal path wins the match. Gated on the
    same floor as editing a PO -- anyone who may change an order may see the
    names they can hand it to -- rather than on people-administration, which
    would leave an editor with a picker they cannot populate. Disabled accounts
    are left out: work should not be handed to someone who can no longer sign in.
    """
    stmt = select(User).where(User.is_active.is_(True)).order_by(User.name)
    return list(db.scalars(stmt))


@router.get("/{user_id}", response_model=UserOut)
def get_user(
    user_id: str, db: Session = Depends(get_db), actor: User = Depends(get_current_user)
) -> User:
    _assert_may_read(actor, user_id)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: str,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    changes = payload.model_dump(exclude_unset=True)
    if "org" in changes:
        changes["org"] = _clean_org(changes["org"])

    # Editing your own name or photo is self-service and open to every rank.
    # Anything else -- another person's record, or a privileged field on your own --
    # is administration, and is fenced by the hierarchy.
    self_service = actor.id == user.id and set(changes) <= SELF_SERVICE_FIELDS
    if not self_service:
        if not has_rank(actor.role, PEOPLE_FLOOR):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"{role_label(PEOPLE_FLOOR)} or above manages accounts; "
                f"you can only change your own photo and name",
            )
        # A Manager editing themselves lands here too, and is refused: self-promotion
        # is the escalation this pair of checks exists to stop.
        assert_may_manage(actor, user)
        if "role" in changes:
            assert_may_assign(actor, changes["role"])

    if _locks_out_admins(db, user, changes):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This is the only admin who can sign in — promote someone else first",
        )

    if "role" in changes and changes["role"] != user.role:
        db.add(
            Activity(
                actor_id=actor.id,
                action="Global role changed",
                entity_type="user",
                entity_id=user.id,
                detail=f"{user.name}: {user.role.value} -> {changes['role'].value}",
            )
        )

    if "org" in changes and changes["org"] != user.org:
        db.add(
            Activity(
                actor_id=actor.id,
                action="Org assigned",
                entity_type="user",
                entity_id=user.id,
                detail=f"{user.name}: {user.org or '—'} -> {changes['org'] or '—'}",
            )
        )

    if "avatar_url" in changes and changes["avatar_url"] != user.avatar_url:
        db.add(
            Activity(
                actor_id=actor.id,
                action="Photo removed" if changes["avatar_url"] is None else "Photo updated",
                entity_type="user",
                entity_id=user.id,
                detail=f"{user.name}: {changes['avatar_url'] or 'back to initials'}",
            )
        )

    password = changes.pop("password", None)
    if password:
        user.password_hash = hash_password(password)
        user.is_pending = False

    for field, value in changes.items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_user(
    user_id: str, db: Session = Depends(get_db), actor: User = Depends(require_admin)
) -> None:
    if user_id == actor.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't delete your own account")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    db.delete(user)
    db.commit()


@router.get("/{user_id}/activity", response_model=list[ActivityOut])
def user_activity(
    user_id: str, db: Session = Depends(get_db), actor: User = Depends(get_current_user)
) -> list[Activity]:
    _assert_may_read(actor, user_id)
    stmt = (
        select(Activity)
        .options(selectinload(Activity.actor))
        .where(Activity.actor_id == user_id)
        .order_by(Activity.created_at.desc())
        .limit(25)
    )
    return list(db.scalars(stmt))
