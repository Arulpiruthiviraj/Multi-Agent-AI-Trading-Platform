import os
from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    """
    Centralized configuration system parsing environment variables and config structures.
    Supports secure runtime overrides, validating settings dynamically.
    """
    ENV: str = "development"
    
    # Database connections
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/trading_db"
    REDIS_URL: str = "redis://localhost:6379/0"
    KAFKA_BOOTSTRAP_SERVERS: str = "localhost:9092"
    CHROMA_DB_URL: Optional[str] = "http://localhost:8000"
    
    # API Secret Keys
    GEMINI_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    
    # Default Trading parameters (Default trade size $100 as specified by instructions)
    DEFAULT_TRADE_SIZE: float = 100.0
    MAX_TRADE_SIZE: float = 5000.0
    
    # Risk Limits (Configurable Risk Layer variables)
    MAX_DAILY_LOSS: float = 1000.0
    MAX_WEEKLY_LOSS: float = 3000.0
    MAX_SECTOR_EXPOSURE: float = 0.35  # Percentage metric: max 35% in any sector
    MAX_POSITION_COUNT: int = 10
    MAX_TOTAL_DRAWDOWN: float = 0.15 # 15% overall cutoff
    
    # Paper Trading mode toggle (Paper trading default MUST be true)
    PAPER_TRADING_ONLY: bool = True
    
    # Model Weights (Initial Default Weights)
    WEIGHT_BASELINE: float = 0.15
    WEIGHT_ML: float = 0.35
    WEIGHT_NARRATIVE: float = 0.25
    WEIGHT_NEWS: float = 0.25
    
    # Model config
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

# Instantiate a global settings singleton
settings = Settings()
