-- Initialize database schema
CREATE TABLE IF NOT EXISTS market_orderbooks (
    id BIGSERIAL PRIMARY KEY,
    market_hash VARCHAR(66) NOT NULL,
    asset_id VARCHAR(255) NOT NULL,
    slug VARCHAR(500),
    market_slug VARCHAR(500),
    market_id BIGINT,
    timestamp BIGINT NOT NULL,
    bids JSONB,
    asks JSONB,
    best_bid DECIMAL(20, 10),
    best_ask DECIMAL(20, 10),
    spread DECIMAL(20, 10),
    last_trade_price DECIMAL(20, 10),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast queries by asset and time
CREATE INDEX idx_orderbooks_asset_time ON market_orderbooks (asset_id, timestamp DESC);
CREATE INDEX idx_orderbooks_market_time ON market_orderbooks (market_hash, timestamp DESC);
CREATE INDEX idx_orderbooks_slug_time ON market_orderbooks (slug, timestamp DESC);
CREATE INDEX idx_orderbooks_market_slug_time ON market_orderbooks (market_slug, timestamp DESC);
CREATE INDEX idx_orderbooks_market_id_time ON market_orderbooks (market_id, timestamp DESC);

-- Optional: Add index for created_at for data retention queries
CREATE INDEX idx_orderbooks_created_at ON market_orderbooks (created_at DESC);

