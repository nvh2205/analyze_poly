"""Database connection utilities."""
import psycopg2
from psycopg2.extras import RealDictCursor
import clickhouse_connect
import redis
from typing import List, Dict, Any, Optional
from datetime import datetime
from config import config


class DatabaseConnector:
    """Manages connections to Postgres, ClickHouse, and Redis."""
    
    def __init__(self):
        self.pg_conn = None
        self.ch_client = None
        self.redis_client = None
    
    def connect_postgres(self):
        """Connect to Postgres."""
        if self.pg_conn is None or self.pg_conn.closed:
            self.pg_conn = psycopg2.connect(
                host=config.postgres_host,
                port=config.postgres_port,
                user=config.postgres_user,
                password=config.postgres_password,
                database=config.postgres_database,
                cursor_factory=RealDictCursor
            )
        return self.pg_conn
    
    def connect_clickhouse(self):
        """Connect to ClickHouse."""
        if self.ch_client is None:
            self.ch_client = clickhouse_connect.get_client(
                host=config.clickhouse_host,
                port=config.clickhouse_port,
                username=config.clickhouse_user,
                password=config.clickhouse_password,
                database=config.clickhouse_database
            )
        return self.ch_client
    
    def connect_redis(self):
        """Connect to Redis."""
        if self.redis_client is None:
            self.redis_client = redis.Redis(
                host=config.redis_host,
                port=config.redis_port,
                password=config.redis_password,
                db=config.redis_db,
                decode_responses=True
            )
        return self.redis_client
    
    def close_all(self):
        """Close all connections."""
        if self.pg_conn and not self.pg_conn.closed:
            self.pg_conn.close()
        if self.ch_client:
            self.ch_client.close()
        if self.redis_client:
            self.redis_client.close()


class MarketLoader:
    """Loads market information from Postgres."""
    
    def __init__(self, db: DatabaseConnector):
        self.db = db
    
    def load_markets_by_type(
        self,
        market_type: str,
        global_start: Optional[datetime] = None,
        global_end: Optional[datetime] = None
    ) -> List[Dict[str, Any]]:
        """
        Load markets by type with optional global time window override.
        
        Args:
            market_type: Market type (e.g., 'btc-updown-15m')
            global_start: Optional global start time override
            global_end: Optional global end time override
        
        Returns:
            List of market records with computed time windows
        """
        conn = self.db.connect_postgres()
        cursor = conn.cursor()
        
        query = """
            SELECT 
                id,
                id as "marketIdClickHouse",
                market_id as "marketId",
                slug,
                question,
                type,
                token_yes as "tokenYes",
                token_no as "tokenNo",
                start_time as "startTime",
                end_date as "endDate",
                active,
                closed,
                volume
            FROM markets
            WHERE type = %s
              AND start_time IS NOT NULL
              AND end_date IS NOT NULL
              AND deleted_at IS NULL
            ORDER BY start_time DESC
        """
        
        cursor.execute(query, (market_type,))
        markets = cursor.fetchall()
        cursor.close()
        
        # Process each market with time window logic
        processed_markets = []
        for market in markets:
            market_dict = dict(market)
            
            # Determine analysis window
            if global_start and global_end:
                # Use global override
                market_dict['analysisStartTime'] = global_start
                market_dict['analysisEndTime'] = global_end
            else:
                # Use per-market window
                market_dict['analysisStartTime'] = market_dict['startTime']
                market_dict['analysisEndTime'] = market_dict['endDate']
            
            processed_markets.append(market_dict)
        
        return processed_markets
    
    def get_token_side(self, market: Dict[str, Any], side: str = 'yes') -> Optional[str]:
        """
        Get token ID for specified side.
        
        Args:
            market: Market record
            side: 'yes' or 'no'
        
        Returns:
            Token ID (asset_id) or None
        """
        if side.lower() == 'yes':
            return market.get('tokenYes')
        elif side.lower() == 'no':
            return market.get('tokenNo')
        return None

