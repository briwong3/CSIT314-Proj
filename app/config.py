import os

from dotenv import load_dotenv

load_dotenv()


class Config:
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///local.db")
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-me")
