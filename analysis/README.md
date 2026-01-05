# Price Range Analytics

Comprehensive price range analysis for Polymarket markets using auto-discovery, first-passage probabilities, and edge ranking.

## Overview

This module analyzes historical price data from ClickHouse to:
1. **Auto-discover** important price ranges based on time-spent histograms
2. Calculate **range statistics** (entries, dwell time, hold/breakout rates)
3. Compute **first-passage probabilities** (hit target before stop)
4. Rank and filter **edge setups** with positive EV and high confidence
5. Cache results in Redis and expose via NestJS API

## Architecture

```
Python Analytics Job → ClickHouse (query data)
                    → Postgres (load markets)
                    → Redis (cache results)
                    → JSON artifacts

NestJS API → Redis (read cached results)
          → Client/Dashboard
```

## Installation

### Setup Python Virtual Environment (Recommended)

**Option 1: Use setup script (recommended)**
```bash
# Run setup script (creates venv and installs dependencies)
./setup_venv.sh

# Activate venv
source activate.sh
```

**Option 2: Manual setup**
```bash
# Create virtual environment
python3 -m venv venv

# Activate virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
# venv\Scripts\activate

# Upgrade pip
pip install --upgrade pip

# Install dependencies
pip install -r analysis/requirements.txt
```

**After activation, your terminal prompt will show `(venv)`**

To deactivate the virtual environment later:
```bash
deactivate
```

### Python Requirements

If you prefer to install without venv (not recommended):
```bash
cd analysis
pip install -r requirements.txt
```

### Environment Variables

Create a `.env` file in the project root:

```bash
# ClickHouse
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=default

# Postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
POSTGRES_DB=strategy_trade_poly

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

## Usage

### Run Analytics Job

**Make sure virtual environment is activated first:**
```bash
source activate.sh  # or: source venv/bin/activate
```

Then run:
```bash
cd analysis
python price_range_analytics.py --market-type btc-updown-15m --token-side yes
```

Or use full path from project root:
```bash
source activate.sh
python analysis/price_range_analytics.py --market-type btc-updown-15m
```

#### Options

- `--market-type`: Market type (e.g., `btc-updown-15m`, `eth-updown-15m`) **[required]**
- `--token-side`: Token side to analyze (`yes` or `no`) **[default: yes]**
- `--global-start`: Global start time override (format: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`)
- `--global-end`: Global end time override
- `--no-cache`: Skip caching to Redis
- `--no-save`: Skip saving JSON artifact

#### Examples

```bash
# Analyze BTC 15m markets (YES side)
python price_range_analytics.py --market-type btc-updown-15m

# Analyze ETH 15m markets (NO side)
python price_range_analytics.py --market-type eth-updown-15m --token-side no

# Use global time window
python price_range_analytics.py \
  --market-type btc-updown-15m \
  --global-start "2024-12-01" \
  --global-end "2024-12-31"

# Run without caching (for testing)
python price_range_analytics.py --market-type btc-updown-15m --no-cache
```

### Access Results via API

Start the NestJS server:

```bash
npm run start:dev
```

#### API Endpoints

**Get full analytics:**
```bash
GET /market/price-ranges?type=btc-updown-15m&tokenSide=yes
```

**Get top edge setups:**
```bash
GET /market/price-ranges/edges?type=btc-updown-15m&limit=10
```

**Get edge summary:**
```bash
GET /market/price-ranges/summary?type=btc-updown-15m
```

**List available types:**
```bash
GET /market/price-ranges/available-types
```

## Configuration

Edit `analysis/config.py` to adjust parameters:

### Range Discovery
- `histogram_bins`: Number of price bins (default: 101 for 0..100 cents)
- `smoothing_window`: Moving average window (default: 5)
- `peak_threshold_quantile`: Peak detection threshold (default: 0.75)
- `min_dwell_secs`: Minimum dwell time for valid range (default: 10s)
- `min_entries`: Minimum entries for valid range (default: 3)

### First-Passage Analysis
- `horizon_secs`: Time horizon to scan (default: 90s)
- `confirm_secs`: Breakout confirmation time (default: 3s)

### Edge Filtering
- `p_min`: Minimum probability (default: 0.70)
- `n_min`: Minimum sample size (default: 10)
- `ci_width_max`: Maximum CI width (default: 0.15)
- `top_k_edges`: Number of top edges to return (default: 20)

## Output Schema

### Analytics Payload

```json
{
  "metadata": {
    "market_type": "btc-updown-15m",
    "token_side": "yes",
    "analysis_start": "2024-12-01T00:00:00",
    "analysis_end": "2024-12-31T23:59:59",
    "generated_at": "2024-12-27T10:30:00",
    "total_markets": 50,
    "total_samples": 125000
  },
  "ranges": [
    {
      "idx": 0,
      "lo": 45,
      "hi": 48,
      "center": 46.5,
      "width": 4
    }
  ],
  "range_stats": [
    {
      "range": {"lo": 45, "hi": 48},
      "entries": 25,
      "total_dwell_secs": 450.0,
      "avg_dwell_secs": 18.0,
      "hold_count": 20,
      "hold_percentage": 80.0,
      "breakout_up_count": 15,
      "breakout_down_count": 5,
      "next_range_after_breakout_up": {1: 12, 2: 3}
    }
  ],
  "first_passage": [...],
  "top_edges": [
    {
      "range_idx": 0,
      "range": {"lo": 55, "hi": 58},
      "direction": "up",
      "p_target": 0.85,
      "n_samples": 45,
      "ci_lower": 0.78,
      "ci_upper": 0.92,
      "ci_width": 0.14,
      "reward_cents": 10,
      "risk_cents": 5,
      "expected_value": 7.75,
      "reward_risk_ratio": 2.0,
      "avg_time_to_target": 35.5,
      "edge_score": 125.3
    }
  ],
  "edge_summary": {
    "total_edges": 15,
    "avg_p_target": 0.82,
    "avg_ev": 6.5,
    "avg_reward_risk": 1.8,
    "max_ev": 12.3
  }
}
```

## Redis Keys

- `analytics:range:{type}:{token_side}:{start_ts}:{end_ts}` - Specific window
- `analytics:range:{type}:{token_side}:latest` - Latest analysis
- TTL: 24 hours (configurable)

## Artifacts

JSON files saved to `analysis/artifacts/`:
- `analytics_{market_type}_{timestamp}.json`

## Workflow Integration

### Cron Job (Recommended)

```bash
# Run analytics every 6 hours
0 */6 * * * cd /path/to/project/analysis && /path/to/venv/bin/python price_range_analytics.py --market-type btc-updown-15m
```

### Manual Trigger

Run on-demand for specific analysis needs or after new market data collection.

## Troubleshooting

### No data found
- Check that markets exist in Postgres with the specified `type`
- Verify ClickHouse has orderbook data for the market's tokens
- Check that `startTime` and `endTime` are valid

### No ranges discovered
- Reduce `min_dwell_secs` or `min_entries` in config
- Check that price data has sufficient variation
- Verify downsample interval produces enough samples

### No edges found
- Relax filtering criteria: lower `p_min`, `n_min`, or increase `ci_width_max`
- Increase `horizon_secs` for longer-term setups
- Check that ranges have sufficient samples for statistical significance

## Development

### Run Tests (when added)
```bash
pytest analysis/tests/
```

### Debugging
Add `print()` statements or use:
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

