-- Extract and downsample price series for a specific asset in a time range
-- Parameters: {asset_id}, {start_time}, {end_time}
-- Output: timestamp (unix seconds), price (mid-price)

WITH raw_data AS (
    SELECT
        toUnixTimestamp(timestamp) AS ts_unix,
        price
    FROM market_orderbooks_analytics
    WHERE asset_id = {asset_id:String}
      AND timestamp >= toDateTime64({start_time:Int64}, 3)
      AND timestamp <= toDateTime64({end_time:Int64}, 3)
      AND isFinite(price)
      AND price >= 0
      AND price <= 1
    ORDER BY timestamp
),
-- Downsample to 1-second intervals by taking the latest price in each second
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
ORDER BY ts_unix;

