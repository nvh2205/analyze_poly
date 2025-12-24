-- Query: Get latest orderbook for a specific asset
SELECT 
    asset_id,
    market_hash,
    timestamp,
    bids,
    asks,
    last_trade_price,
    created_at
FROM market_orderbooks
WHERE asset_id = 'YOUR_ASSET_ID'
ORDER BY timestamp DESC
LIMIT 1;

-- Query: Get orderbook history for an asset in a time range
SELECT 
    asset_id,
    timestamp,
    jsonb_array_length(bids) as bid_levels,
    jsonb_array_length(asks) as ask_levels,
    last_trade_price,
    created_at
FROM market_orderbooks
WHERE asset_id = 'YOUR_ASSET_ID'
    AND timestamp BETWEEN 1700000000 AND 1700100000
ORDER BY timestamp DESC;

-- Query: Count records per asset
SELECT 
    asset_id,
    COUNT(*) as record_count,
    MIN(created_at) as first_seen,
    MAX(created_at) as last_seen
FROM market_orderbooks
GROUP BY asset_id
ORDER BY record_count DESC;

-- Query: Get top bid/ask for latest orderbook
SELECT 
    asset_id,
    timestamp,
    (bids->0->>'price')::numeric as best_bid,
    (asks->0->>'price')::numeric as best_ask,
    ((asks->0->>'price')::numeric - (bids->0->>'price')::numeric) as spread
FROM market_orderbooks
WHERE asset_id = 'YOUR_ASSET_ID'
ORDER BY timestamp DESC
LIMIT 1;

-- Query: Data volume statistics
SELECT 
    DATE(created_at) as date,
    COUNT(*) as records,
    COUNT(DISTINCT asset_id) as unique_assets,
    pg_size_pretty(pg_total_relation_size('market_orderbooks')) as table_size
FROM market_orderbooks
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Query: Find assets with most activity
SELECT 
    asset_id,
    COUNT(*) as updates,
    MAX(timestamp) as last_update,
    COUNT(DISTINCT market_hash) as markets
FROM market_orderbooks
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY asset_id
ORDER BY updates DESC
LIMIT 10;

-- Query: Database maintenance - Delete old data (older than 30 days)
-- DELETE FROM market_orderbooks 
-- WHERE created_at < NOW() - INTERVAL '30 days';

-- Query: Analyze table performance
ANALYZE market_orderbooks;

-- Query: Check index usage
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename = 'market_orderbooks'
ORDER BY idx_scan DESC;

