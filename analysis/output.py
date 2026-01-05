"""Output and caching for analytics results."""
import json
import os
from datetime import datetime
from typing import Dict, Any, List
from database import DatabaseConnector
from range_discovery import PriceRange
from range_analyzer import RangeStats
from first_passage import FirstPassageResult
from edge_ranker import EdgeSetup
from config import config


class AnalyticsOutput:
    """Handles output and caching of analytics results."""
    
    def __init__(self, db: DatabaseConnector):
        self.db = db
        self.artifacts_dir = config.artifacts_dir
        self.redis_key_prefix = config.redis_key_prefix
        self.redis_ttl = config.redis_ttl_secs
    
    def create_payload(
        self,
        market_type: str,
        token_side: str,
        start_time: datetime,
        end_time: datetime,
        ranges: List[PriceRange],
        range_stats: List[RangeStats],
        first_passage_results: List[FirstPassageResult],
        top_edges: List[EdgeSetup],
        edge_summary: Dict[str, Any],
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Create analytics payload.
        
        Args:
            market_type: Market type
            token_side: Token side
            start_time: Analysis start time
            end_time: Analysis end time
            ranges: Discovered ranges
            range_stats: Range statistics
            first_passage_results: First-passage results
            top_edges: Top edge setups
            edge_summary: Edge summary stats
            metadata: Additional metadata
        
        Returns:
            Complete payload dictionary
        """
        payload = {
            'metadata': {
                'market_type': market_type,
                'token_side': token_side,
                'analysis_start': start_time.isoformat(),
                'analysis_end': end_time.isoformat(),
                'generated_at': datetime.utcnow().isoformat(),
                'version': '1.0',
                **(metadata or {})
            },
            'ranges': [
                {
                    'idx': i,
                    'lo': r.lo,
                    'hi': r.hi,
                    'center': r.center(),
                    'width': r.width()
                }
                for i, r in enumerate(ranges)
            ],
            'range_stats': [s.to_dict() for s in range_stats],
            'first_passage': [fp.to_dict() for fp in first_passage_results],
            'top_edges': [e.to_dict() for e in top_edges],
            'edge_summary': edge_summary
        }
        
        return payload
    
    def save_to_json(
        self,
        payload: Dict[str, Any],
        market_type: str,
        start_time: datetime,
        end_time: datetime
    ) -> str:
        """
        Save payload to JSON file.
        
        Args:
            payload: Analytics payload
            market_type: Market type
            start_time: Start time
            end_time: End time
        
        Returns:
            Path to saved file
        """
        # Ensure artifacts directory exists
        os.makedirs(self.artifacts_dir, exist_ok=True)
        
        # Create filename
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        filename = f"analytics_{market_type}_{timestamp}.json"
        filepath = os.path.join(self.artifacts_dir, filename)
        
        # Save
        with open(filepath, 'w') as f:
            json.dump(payload, f, indent=2)
        
        print(f"Saved analytics to {filepath}")
        return filepath
    
    def cache_to_redis(
        self,
        payload: Dict[str, Any],
        market_type: str,
        start_time: datetime,
        end_time: datetime,
        token_side: str = 'yes'
    ) -> str:
        """
        Cache payload to Redis.
        
        Args:
            payload: Analytics payload
            market_type: Market type
            start_time: Start time
            end_time: End time
            token_side: Token side
        
        Returns:
            Redis key
        """
        redis_client = self.db.connect_redis()
        
        # Create key
        start_ts = int(start_time.timestamp())
        end_ts = int(end_time.timestamp())
        key = f"{self.redis_key_prefix}:{market_type}:{token_side}:{start_ts}:{end_ts}"
        
        # Serialize payload
        payload_json = json.dumps(payload)
        
        # Set in Redis with TTL
        redis_client.setex(key, self.redis_ttl, payload_json)
        
        print(f"Cached analytics to Redis: {key}")
        print(f"TTL: {self.redis_ttl} seconds ({self.redis_ttl / 3600:.1f} hours)")
        
        # Also set a "latest" key for this market type + token side
        latest_key = f"{self.redis_key_prefix}:{market_type}:{token_side}:latest"
        redis_client.setex(latest_key, self.redis_ttl, payload_json)
        print(f"Updated latest key: {latest_key}")
        
        return key
    
    def get_from_redis(
        self,
        market_type: str,
        start_time: datetime,
        end_time: datetime,
        token_side: str = 'yes'
    ) -> Dict[str, Any]:
        """
        Retrieve cached payload from Redis.
        
        Args:
            market_type: Market type
            start_time: Start time
            end_time: End time
            token_side: Token side
        
        Returns:
            Payload dictionary or None
        """
        redis_client = self.db.connect_redis()
        
        start_ts = int(start_time.timestamp())
        end_ts = int(end_time.timestamp())
        key = f"{self.redis_key_prefix}:{market_type}:{token_side}:{start_ts}:{end_ts}"
        
        payload_json = redis_client.get(key)
        
        if payload_json:
            return json.loads(payload_json)
        
        return None
    
    def get_latest_from_redis(
        self,
        market_type: str,
        token_side: str = 'yes'
    ) -> Dict[str, Any]:
        """
        Retrieve latest cached payload for a market type.
        
        Args:
            market_type: Market type
            token_side: Token side
        
        Returns:
            Payload dictionary or None
        """
        redis_client = self.db.connect_redis()
        
        latest_key = f"{self.redis_key_prefix}:{market_type}:{token_side}:latest"
        payload_json = redis_client.get(latest_key)
        
        if payload_json:
            return json.loads(payload_json)
        
        return None

