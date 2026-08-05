import mimetypes
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import migrations
from .config import settings
from .db import Base, SessionLocal, engine
from .routers import auth, meta, purchase_orders, uploads, users
from .routers.uploads import UPLOAD_DIR
from .seed import seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    for column in migrations.run(engine):
        print(f"migration: added {column}")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if settings.seed_on_start:
        with SessionLocal() as db:
            seed(db)
    yield


app = FastAPI(title="PO Calendar API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(purchase_orders.router)
app.include_router(users.router)
app.include_router(meta.router)
app.include_router(uploads.router)

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Starlette falls back to text/plain for extensions Python doesn't know, which is
# actively wrong for a binary FBX or 3DM. Teach it the model types before the
# static mount so the browser gets a truthful Content-Type.
for _extension, _media_type in {
    ".obj": "model/obj",
    ".fbx": "application/octet-stream",
    ".stp": "model/step",
    ".step": "model/step",
    ".3dm": "model/vnd.3dm",
}.items():
    mimetypes.add_type(_media_type, _extension)

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "auth_provider": settings.auth_provider}
