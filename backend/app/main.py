from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, Response

from . import migrations
from .config import settings
from .db import Base, SessionLocal, engine
from .routers import auth, cluster, fabric, maxlps, meta, provision, purchase_orders, staff_tasks, uploads, users, workloads
from .routers import settings as settings_router
from .seed import seed
from .storage import UPLOAD_DIR, object_storage_configured, serve_upload


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    for column in migrations.run(engine):
        print(f"migration: added {column}")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    # Seed the singleton board settings row so /api/meta/* and the board share
    # one catalog from the first request.
    from . import board_service

    with SessionLocal() as db:
        board_service.ensure_row(db)
        if settings.seed_on_start:
            seed(db)
    backend = "s3" if object_storage_configured() else "local"
    print(f"uploads: backend={backend}")
    yield


app = FastAPI(title="L12 App API", version="0.2.0", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=2000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|172\.\d+\.\d+\.\d+|karam-e-nil)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Content-Disposition is not CORS-safelisted: without this the browser hides
    # it from fetch(), so traveler downloads lose their filename + extension.
    expose_headers=[
        "Content-Disposition",
        "Content-Length",
        "X-Traveler-Preview-Source",
        "X-Traveler-Preview-Ms",
    ],
)

app.include_router(auth.router)
app.include_router(cluster.router)
app.include_router(maxlps.router)
app.include_router(fabric.router)
app.include_router(provision.router)
app.include_router(workloads.router)
app.include_router(purchase_orders.router)
app.include_router(users.router)
app.include_router(meta.router)
app.include_router(settings_router.router)
app.include_router(uploads.router)
app.include_router(staff_tasks.router)

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/uploads/{name}")
def get_upload(name: str) -> Response:
    # Local disk first, then the configured object store — so a free Render
    # instance that just woke still has every file that survived in the bucket.
    return serve_upload(name)


@app.get("/login")
def kvm_login_bounce() -> HTMLResponse:
    """NVIDIA webui does window.location='/login' on 401; send the iframe back to the KVM proxy."""
    return HTMLResponse(
        "<!doctype html><script>var p=sessionStorage.getItem('l12-kvm-prefix');"
        "if(p) location.replace(p+'/#/login');"
        "else document.body.textContent='Open KVM from Provision again.';</script>"
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "auth_provider": settings.auth_provider,
        "uploads": "s3" if object_storage_configured() else "local",
    }
