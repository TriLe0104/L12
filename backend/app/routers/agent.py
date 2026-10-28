"""Grok operator chat — tools run server-side; the API key never leaves this process."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import agent, agent_jobs
from ..config import settings
from ..db import get_db
from ..models import AgentAttachment, AgentDoc, User, has_rank
from ..security import EDITOR_FLOOR, get_current_user, require_editor

router = APIRouter(prefix="/api/agent", tags=["agent"])

_MAX_SOP = 8 * 1024 * 1024
_SOP_EXT = agent.ATTACH_EXT - {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_MAX_ATTACH = 8 * 1024 * 1024


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role: Literal["user", "assistant"]
    content: str = ""

    @field_validator("role", mode="before")
    @classmethod
    def _role(cls, value: Any) -> str:
        raw = str(value or "user").strip().lower()
        return raw if raw in ("user", "assistant") else "user"

    @field_validator("content", mode="before")
    @classmethod
    def _content(cls, value: Any) -> str:
        if value is None:
            return ""
        return str(value)[:8000]


class ChatContext(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str | None = None


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    messages: list[ChatMessage] = Field(default_factory=list, max_length=80)
    context: ChatContext | None = None
    execute: dict[str, Any] | None = None
    attachment_ids: list[str] = Field(default_factory=list, max_length=8)


class ConsoleIn(BaseModel):
    node: str
    command: str = ""
    via: str | None = None


class ChatOut(BaseModel):
    reply: str
    enabled: bool
    actions: list[dict[str, Any]] = []
    choices: list[dict[str, Any]] = []
    mutated: bool = False
    model: str | None = None
    ui: list[dict[str, Any]] = []


class KeyIn(BaseModel):
    key: str = ""


def _extract_sop(filename: str, data: bytes) -> str:
    parsed = agent.extract_upload(filename, data)
    if parsed.get("kind") == "image":
        return ""
    return (parsed.get("text") or "").strip()


@router.get("/status")
def agent_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    on = agent.enabled(db)
    return {
        "enabled": on,
        "configured": on,
        "online": on,
        "hint": agent.key_hint(db),
        "model": agent.operator_model() if on else None,
        "can_edit": has_rank(user.role, EDITOR_FLOOR),
    }


@router.put("/key")
def put_agent_key(
    payload: KeyIn,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return agent.set_api_key(db, payload.key)


@router.get("/docs")
def list_agent_docs(_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = list(db.scalars(select(AgentDoc).order_by(AgentDoc.created_at.desc())).all())
    return [
        {"id": d.id, "title": d.title, "filename": d.filename, "chars": len(d.text or ""), "created_at": d.created_at}
        for d in rows
    ]


@router.post("/docs")
async def add_agent_doc(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    name = Path(file.filename or "sop.txt").name
    ext = Path(name).suffix.lower()
    if ext not in _SOP_EXT:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use txt, md, csv, log, json, yaml, pdf, docx, or xlsx")
    data = await file.read()
    if len(data) > _MAX_SOP:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "File is too large")
    text = _extract_sop(name, data).strip()
    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not read text from that file")
    if len(text) > 80000:
        text = text[:80000] + "\n[truncated]"
    label = (title or "").strip() or Path(name).stem
    doc = AgentDoc(title=label[:200], filename=name, text=text)
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return {"id": doc.id, "title": doc.title, "filename": doc.filename, "chars": len(doc.text or "")}


@router.delete("/docs/{doc_id}")
def delete_agent_doc(
    doc_id: str,
    _user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    doc = db.get(AgentDoc, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found")
    db.delete(doc)
    db.commit()
    return {"ok": True}


@router.post("/console")
def agent_console(
    payload: ConsoleIn,
    user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return agent.tool_os_exec(db, user, node=payload.node, command=payload.command, via=payload.via)


@router.get("/jobs")
def list_agent_jobs(_user: User = Depends(get_current_user)) -> dict[str, Any]:
    rows = agent_jobs.list_jobs()
    live = sum(1 for r in rows if r.get("status") == "running")
    return {"jobs": rows, "running": live}


@router.post("/jobs/{job_id}/stop")
def stop_agent_job(
    job_id: str,
    user: User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    out = agent_jobs.stop(job_id, db, user)
    if not out.get("ok"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, out.get("error") or "agent not found")
    return out


@router.get("/attachments")
def list_agent_attachments(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_public_attachment(row) for row in agent._user_attachments(db, user)]


@router.post("/attachments")
async def add_agent_attachment(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    name = Path(file.filename or "file").name
    ext = Path(name).suffix.lower()
    if ext not in agent.ATTACH_EXT:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Use txt, md, csv, log, json, yaml, pdf, docx, xlsx, png, jpg, webp, or gif",
        )
    data = await file.read()
    if len(data) > _MAX_ATTACH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "File is too large")
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")
    parsed = agent.extract_upload(name, data)
    if parsed["kind"] == "text" and not (parsed.get("text") or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not read text from that file")
    row = agent.save_attachment(db, user, name, data, file.content_type)
    return _public_attachment(row)


@router.post("/chat", response_model=ChatOut)
def agent_chat(
    payload: ChatIn,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatOut:
    ctx = payload.context.model_dump() if payload.context else None
    auth = request.headers.get("authorization") or ""
    try:
        result = agent.run_chat(
            db,
            user,
            [m.model_dump() for m in payload.messages],
            context=ctx,
            execute=payload.execute,
            attachment_ids=list(payload.attachment_ids or []),
            auth_header=auth,
        )
    except Exception as exc:
        return ChatOut(
            reply=agent.chat_crash(exc),
            enabled=agent.enabled(db),
            actions=[],
            choices=[],
            mutated=False,
            model=None,
            ui=[],
        )
    return ChatOut(
        reply=str(result.get("reply") or ""),
        enabled=bool(result.get("enabled")),
        actions=list(result.get("actions") or []),
        choices=list(result.get("choices") or []),
        mutated=bool(result.get("mutated")),
        model=result.get("model"),
        ui=list(result.get("ui") or []),
    )


def _public_attachment(row: AgentAttachment) -> dict[str, Any]:
    return {
        "id": row.id,
        "filename": row.filename,
        "kind": row.kind,
        "mime": row.mime,
        "chars": len(row.text or ""),
        "url": row.url,
        "created_at": row.created_at,
    }
