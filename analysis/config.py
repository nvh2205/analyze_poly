"""Configuration for price range analytics."""
import os
from pathlib import Path
from dataclasses import dataclass
from typing import Optional
from dotenv import load_dotenv

# Load .env file from analysis directory
env_path = Path(__file__).parent / '.env'
load_dotenv(dotenv_path=env_path)


@dataclass
class AnalyticsConfig:
    """Configuration parameters for price range analytics."""
    
    # Database connections
    clickhouse_host: str = os.getenv('CLICKHOUSE_HOST', 'localhost')
    clickhouse_port: int = int(os.getenv('CLICKHOUSE_PORT', '8123'))
    clickhouse_user: str = os.getenv('CLICKHOUSE_USER', 'default')
    clickhouse_password: str = os.getenv('CLICKHOUSE_PASSWORD', '')
    clickhouse_database: str = os.getenv('CLICKHOUSE_DATABASE', 'default')
    
    postgres_host: str = os.getenv('POSTGRES_HOST', 'localhost')
    postgres_port: int = int(os.getenv('POSTGRES_PORT', '5432'))
    postgres_user: str = os.getenv('POSTGRES_USER', 'postgres')
    postgres_password: str = os.getenv('POSTGRES_PASSWORD', '')
    postgres_database: str = os.getenv('POSTGRES_DB', 'strategy_trade_poly')
    
    redis_host: str = os.getenv('REDIS_HOST', 'localhost')
    redis_port: int = int(os.getenv('REDIS_PORT', '6379'))
    redis_password: Optional[str] = os.getenv('REDIS_PASSWORD', None)
    redis_db: int = int(os.getenv('REDIS_DB', '0'))
    
    # Analysis parameters
    downsample_interval_secs: int = 1  # Downsample to 1s intervals
    price_multiplier: int = 100  # Convert 0..1 to 0..100 cents
    
    # Auto-range discovery
    histogram_bins: int = 101  # 0..100 cents
    smoothing_window: int = 5  # Moving average window for smoothing
    peak_threshold_quantile: float = 0.75  # Threshold for peak detection
    min_dwell_secs: int = 10  # Minimum dwell time for a range to be valid
    min_entries: int = 3  # Minimum entries for a range to be valid
    
    # Breakout detection
    confirm_secs: int = 3  # Seconds to confirm breakout
    
    # First-passage analysis
    horizon_secs: int = 90  # Time horizon for first-passage
    
    # Hold detection
    hold_secs_threshold: int = 5  # Minimum seconds to count as "hold"
    
    # Edge scoring
    p_min: float = 0.70  # Minimum probability for edge
    n_min: int = 10  # Minimum samples for edge
    ci_width_max: float = 0.15  # Maximum CI width (95% CI)
    top_k_edges: int = 20  # Number of top edges to return
    
    # Token side
    default_token_side: str = 'yes'  # 'yes' or 'no'
    
    # Output
    artifacts_dir: str = 'analysis/artifacts'
    redis_key_prefix: str = 'analytics:range'
    redis_ttl_secs: int = 86400  # 24 hours


# Global config instance
config = AnalyticsConfig()

