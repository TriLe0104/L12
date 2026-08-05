from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import Activity, Role, User
from ..schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut
from ..security import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/config")
def auth_config() -> dict[str, object]:
    return {"provider": settings.auth_provider, "allow_signup": settings.allow_signup}


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    if not settings.allow_signup:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sign-up is closed on this instance")

    email = payload.email.lower().strip()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "That email already has an account — sign in instead"
        )

    try:
        role = Role(settings.signup_default_role)
    except ValueError:
        role = Role.VIEWER

    user = User(
        email=email,
        name=payload.name.strip(),
        role=role,
        password_hash=hash_password(payload.password),
        is_pending=False,
        last_login_at=datetime.now(timezone.utc),
    )
    db.add(user)
    db.flush()
    db.add(
        Activity(
            actor_id=user.id,
            action="Account registered",
            entity_type="user",
            entity_id=user.id,
            detail=f"{user.email} · {role.value}",
        )
    )
    db.commit()
    db.refresh(user)
    return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.scalar(select(User).where(User.email == payload.email.lower().strip()))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account disabled")

    user.last_login_at = datetime.now(timezone.utc)
    db.add(Activity(actor_id=user.id, action="Signed in", entity_type="user", entity_id=user.id))
    db.commit()
    db.refresh(user)
    return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user
