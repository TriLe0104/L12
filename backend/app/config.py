from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # sqlite fallback keeps the prototype runnable without a Postgres server.
    # Docker compose overrides this with the postgres DSN.
    database_url: str = "sqlite:///./po_calendar.db"

    jwt_secret: str = "dev-only-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 12

    # "local" = email + password (prototype).
    # "entra" / "auth0" reserved for the OIDC swap later.
    auth_provider: str = "local"

    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_audience: str | None = None

    seed_on_start: bool = True
    bootstrap_admin_name: str = "Test"
    bootstrap_admin_email: str = "test@test"
    bootstrap_admin_password: str = "test"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:3333,http://127.0.0.1:3333"

    # Cluster Backend Controller — source of truth for MaxLPS rack / shelf identity.
    cluster_controller_url: str = "http://172.25.231.244:8000"
    cluster_controller_user: str = "admin"
    cluster_controller_password: str = "admin"
    cluster_controller_sync_s: float = 60.0
    cluster_pxe_host: str = "172.25.231.244"
    cluster_pxe_user: str = "root"

    # S3-compatible object storage (Cloudflare R2, AWS S3, MinIO, …). When all
    # of endpoint / bucket / keys are set, uploads survive container restarts.
    # Leave unset for local disk under backend/uploads/.
    s3_endpoint_url: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_bucket: str | None = None
    s3_region: str = "auto"
    # Optional public CDN / r2.dev base. When set, the API returns absolute
    # URLs and /uploads/{name} redirects there. When unset, /uploads/{name}
    # streams from the (private) bucket through this app.
    s3_public_base_url: str | None = None

    @field_validator("database_url")
    @classmethod
    def use_psycopg_driver(cls, value: str) -> str:
        # Managed providers publish a generic Postgres URL. This project ships
        # psycopg 3, so make the SQLAlchemy driver explicit.
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
