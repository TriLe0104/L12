from functools import lru_cache

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

    # Open sign-up for the prototype. Self-registration lands on the lowest
    # signed-in rung; set SIGNUP_DEFAULT_ROLE=viewer (or ALLOW_SIGNUP=false)
    # before staging so a stray registration gets even less.
    allow_signup: bool = True
    signup_default_role: str = "user"
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_audience: str | None = None

    seed_on_start: bool = True
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
