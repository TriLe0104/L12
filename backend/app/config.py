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
    bootstrap_admin_name: str = "Demo Admin"
    bootstrap_admin_email: str = "tri@supermicro.com"
    bootstrap_admin_password: str = "demo1234"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

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
