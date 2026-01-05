"""Price series extraction from ClickHouse."""
import numpy as np
from typing import List, Tuple, Dict, Any
from datetime import datetime, timezone
from database import DatabaseConnector
from config import config


class PriceSeriesExtractor:
    """Extracts and processes price series from ClickHouse."""
    
    def __init__(self, db: DatabaseConnector):
        self.db = db

    def _to_unix_utc(self, dt: datetime) -> int:
        """
        Convert datetime to unix seconds in UTC.
        Naive datetimes are treated as UTC to avoid local timezone shifts.
        """
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return int(dt.timestamp())
    
    def check_data_exists(
        self,
        asset_id: str,
        market_id: str,
        start_time: datetime,
        end_time: datetime
    ) -> Dict[str, Any]:
        """
        Check if data exists in ClickHouse for debugging.
        
        Returns:
            Dict with diagnostic information
        """
        client = self.db.connect_clickhouse()
        start_unix = self._to_unix_utc(start_time)
        end_unix = self._to_unix_utc(end_time)
        
        # Check total rows
        count_query = """
        SELECT count() as total_rows
        FROM market_orderbooks_analytics
        WHERE asset_id = {asset_id:String}
          AND market_id = {market_id:String}
          AND timestamp >= toDateTime64({start_time:Int64}, 3)
          AND timestamp <= toDateTime64({end_time:Int64}, 3)
        """
        
        count_result = client.query(
            count_query,
            parameters={
                'asset_id': asset_id,
                'market_id': str(market_id),
                'start_time': start_unix,
                'end_time': end_unix
            }
        )
        total_rows = count_result.result_rows[0][0] if count_result.row_count > 0 else 0
        
        # Check filtered rows
        filtered_query = """
        SELECT count() as filtered_rows
        FROM market_orderbooks_analytics
        WHERE asset_id = {asset_id:String}
          AND market_id = {market_id:String}
          AND timestamp >= toDateTime64({start_time:Int64}, 3)
          AND timestamp <= toDateTime64({end_time:Int64}, 3)
          AND isFinite(price)
          AND price >= 0
          AND price <= 1
        """
        
        filtered_result = client.query(
            filtered_query,
            parameters={
                'asset_id': asset_id,
                'market_id': str(market_id),
                'start_time': start_unix,
                'end_time': end_unix
            }
        )
        filtered_rows = filtered_result.result_rows[0][0] if filtered_result.row_count > 0 else 0
        
        # Check time range
        time_range_query = """
        SELECT 
            min(timestamp) as min_ts,
            max(timestamp) as max_ts
        FROM market_orderbooks_analytics
        WHERE asset_id = {asset_id:String}
          AND market_id = {market_id:String}
        """
        
        time_result = client.query(
            time_range_query,
            parameters={
                'asset_id': asset_id,
                'market_id': str(market_id)
            }
        )
        
        min_ts = None
        max_ts = None
        if time_result.row_count > 0 and time_result.result_rows[0][0]:
            min_ts = time_result.result_rows[0][0]
            max_ts = time_result.result_rows[0][1]
        
        return {
            'total_rows': total_rows,
            'filtered_rows': filtered_rows,
            'min_timestamp': min_ts,
            'max_timestamp': max_ts,
            'requested_start': start_time,
            'requested_end': end_time
        }
    
    def extract_price_series(
        self,
        asset_id: str,
        market_id: str,
        start_time: datetime,
        end_time: datetime
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Extract price series for an asset in a time range.
        
        Args:
            asset_id: Asset ID (token ID)
            market_id: Market ID (id from PostgreSQL markets table)
            start_time: Start datetime
            end_time: End datetime
        
        Returns:
            Tuple of (timestamps_unix_sec, prices_cent)
            - timestamps: Unix seconds as int64 array
            - prices: Prices in cents (0..100) as int64 array
        """
        client = self.db.connect_clickhouse()
        
        # Convert datetime to unix timestamp (UTC)
        start_unix = self._to_unix_utc(start_time)
        end_unix = self._to_unix_utc(end_time)
        
        query = """
        WITH raw_data AS (
            SELECT
                toUnixTimestamp(timestamp) AS ts_unix,
                price
            FROM market_orderbooks_analytics
            WHERE asset_id = {asset_id:String}
              AND market_id = {market_id:String}
              AND timestamp >= toDateTime64({start_time:Int64}, 3)
              AND timestamp <= toDateTime64({end_time:Int64}, 3)
              AND isFinite(price)
              AND price >= 0
              AND price <= 1
            ORDER BY timestamp
        ),
        downsampled AS (
            SELECT
                ts_unix,
                argMax(price, ts_unix) AS price
            FROM raw_data
            GROUP BY ts_unix
            ORDER BY ts_unix
        )
        SELECT
            ts_unix,
            price
        FROM downsampled
        ORDER BY ts_unix
        """
        
        result = client.query(
            query,
            parameters={
                'asset_id': asset_id,
                'market_id': str(market_id),
                'start_time': start_unix,
                'end_time': end_unix
            }
        )
        
        if result.row_count == 0:
            return np.array([], dtype=np.int64), np.array([], dtype=np.int64)
        
        # Extract data
        timestamps = []
        prices = []
        
        for row in result.result_rows:
            ts_unix = int(row[0])
            price_float = float(row[1])
            
            # Convert to cents (0..100)
            price_cent = int(round(price_float * config.price_multiplier))
            
            # Clamp to valid range
            price_cent = max(0, min(100, price_cent))
            
            timestamps.append(ts_unix)
            prices.append(price_cent)
        
        return np.array(timestamps, dtype=np.int64), np.array(prices, dtype=np.int64)
    
    def extract_aggregated_series(
        self,
        markets: List[Dict[str, Any]],
        token_side: str = 'yes'
    ) -> Dict[str, Tuple[np.ndarray, np.ndarray]]:
        """
        Extract price series for multiple markets.
        
        Args:
            markets: List of market records (with analysisStartTime, analysisEndTime)
            token_side: 'yes' or 'no'
        
        Returns:
            Dict mapping market_id -> (timestamps, prices_cent)
        """
        from database import MarketLoader
        
        loader = MarketLoader(self.db)
        result = {}
        
        for market in markets:
            market_id = market['marketId']
            market_id_clickhouse = market.get('marketIdClickHouse', market_id)  # Use id from PostgreSQL
            token_id = loader.get_token_side(market, token_side)
            
            if not token_id:
                print(f"Warning: No token {token_side} for market {market_id}")
                continue
            
            start_time = market['analysisStartTime']
            end_time = market['analysisEndTime']
            
            try:
                timestamps, prices = self.extract_price_series(
                    token_id,
                    market_id_clickhouse,
                    start_time,
                    end_time
                )
                
                if len(timestamps) > 0:
                    result[market_id] = (timestamps, prices)
                else:
                    print(f"Warning: No data for market {market_id} (asset {token_id}, ch_id {market_id_clickhouse})")
            except Exception as e:
                print(f"Error extracting data for market {market_id}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        return result
    
    def aggregate_all_series(
        self,
        series_dict: Dict[str, Tuple[np.ndarray, np.ndarray]]
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Aggregate all market series into one combined series.
        
        Args:
            series_dict: Dict of market_id -> (timestamps, prices)
        
        Returns:
            Combined (timestamps, prices) sorted by timestamp
        """
        all_timestamps = []
        all_prices = []
        
        for market_id, (timestamps, prices) in series_dict.items():
            all_timestamps.extend(timestamps)
            all_prices.extend(prices)
        
        if len(all_timestamps) == 0:
            return np.array([], dtype=np.int64), np.array([], dtype=np.int64)
        
        # Sort by timestamp
        sort_idx = np.argsort(all_timestamps)
        
        return (
            np.array(all_timestamps, dtype=np.int64)[sort_idx],
            np.array(all_prices, dtype=np.int64)[sort_idx]
        )

