#!/usr/bin/env python3
"""Main script for price range analytics."""
import argparse
import sys
from datetime import datetime
from typing import Optional

from config import config
from database import DatabaseConnector, MarketLoader
from price_series import PriceSeriesExtractor
from range_discovery import RangeDiscovery
from range_analyzer import RangeAnalyzer
from first_passage import FirstPassageAnalyzer
from edge_ranker import EdgeRanker
from output import AnalyticsOutput


def parse_datetime(date_str: Optional[str]) -> Optional[datetime]:
    """Parse datetime string."""
    if not date_str:
        return None
    
    # Try various formats
    formats = [
        '%Y-%m-%d',
        '%Y-%m-%d %H:%M:%S',
        '%Y-%m-%dT%H:%M:%S',
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    
    raise ValueError(f"Could not parse datetime: {date_str}")


def main():
    parser = argparse.ArgumentParser(
        description='Analyze price ranges and edge setups for Polymarket markets'
    )
    parser.add_argument(
        '--market-type',
        required=True,
        help='Market type (e.g., btc-updown-15m, eth-updown-15m)'
    )
    parser.add_argument(
        '--token-side',
        default='yes',
        choices=['yes', 'no'],
        help='Token side to analyze (default: yes)'
    )
    parser.add_argument(
        '--global-start',
        help='Global start time override (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)'
    )
    parser.add_argument(
        '--global-end',
        help='Global end time override (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)'
    )
    parser.add_argument(
        '--no-cache',
        action='store_true',
        help='Skip caching to Redis'
    )
    parser.add_argument(
        '--no-save',
        action='store_true',
        help='Skip saving to JSON file'
    )
    
    args = parser.parse_args()
    
    # Parse datetime overrides
    global_start = parse_datetime(args.global_start) if args.global_start else None
    global_end = parse_datetime(args.global_end) if args.global_end else None
    
    print("=" * 80)
    print("PRICE RANGE ANALYTICS")
    print("=" * 80)
    print(f"Market Type: {args.market_type}")
    print(f"Token Side: {args.token_side}")
    if global_start:
        print(f"Global Start: {global_start}")
    if global_end:
        print(f"Global End: {global_end}")
    print("=" * 80)
    
    # Initialize database connector
    db = DatabaseConnector()
    
    try:
        # Step 1: Load markets
        print("\n[1/8] Loading markets...")
        loader = MarketLoader(db)
        markets = loader.load_markets_by_type(
            args.market_type,
            global_start=global_start,
            global_end=global_end
        )
        
        if len(markets) == 0:
            print(f"ERROR: No markets found for type '{args.market_type}'")
            sys.exit(1)
        
        print(f"Loaded {len(markets)} markets")
        
        # Step 2: Extract price series
        print("\n[2/8] Extracting price series...")
        extractor = PriceSeriesExtractor(db)
        series_dict = extractor.extract_aggregated_series(markets, args.token_side)
        
        if len(series_dict) == 0:
            print("ERROR: No price data found")
            sys.exit(1)
        
        print(f"Extracted data from {len(series_dict)} markets")
        
        # Aggregate all series
        timestamps, prices = extractor.aggregate_all_series(series_dict)
        print(f"Total samples: {len(timestamps)}")
        
        if len(timestamps) == 0:
            print("ERROR: No aggregated data")
            sys.exit(1)
        
        # Step 3: Discover ranges
        print("\n[3/8] Discovering price ranges...")
        discovery = RangeDiscovery()
        ranges = discovery.discover_ranges(timestamps, prices)
        
        if len(ranges) == 0:
            print("WARNING: No ranges discovered")
            sys.exit(0)
        
        print(f"Discovered {len(ranges)} ranges:")
        for i, r in enumerate(ranges):
            print(f"  {i}. {r}")
        
        # Step 4: Analyze range statistics
        print("\n[4/8] Analyzing range statistics...")
        analyzer = RangeAnalyzer()
        range_stats = analyzer.analyze_ranges(timestamps, prices, ranges)
        
        # Step 5: First-passage analysis
        print("\n[5/8] Computing first-passage probabilities...")
        fp_analyzer = FirstPassageAnalyzer()
        fp_results = fp_analyzer.analyze_all_ranges(timestamps, prices, ranges)
        
        if len(fp_results) == 0:
            print("WARNING: No first-passage results")
        
        # Step 6: Rank edges
        print("\n[6/8] Ranking edge setups...")
        ranker = EdgeRanker()
        top_edges = ranker.rank_edges(fp_results, ranges)
        edge_summary = ranker.get_summary_stats(top_edges)
        
        print(f"\nEdge Summary:")
        print(f"  Total edges: {edge_summary['total_edges']}")
        if edge_summary['total_edges'] > 0:
            print(f"  Avg P(target): {edge_summary['avg_p_target']:.2%}")
            print(f"  Avg EV: {edge_summary['avg_ev']:.2f} cents")
            print(f"  Avg R/R: {edge_summary['avg_reward_risk']:.2f}")
            print(f"  Max EV: {edge_summary['max_ev']:.2f} cents")
        
        # Step 7: Create payload
        print("\n[7/8] Creating output payload...")
        output_handler = AnalyticsOutput(db)
        
        # Determine time window for metadata
        if global_start and global_end:
            analysis_start = global_start
            analysis_end = global_end
        else:
            # Use first market's window
            analysis_start = markets[0]['analysisStartTime']
            analysis_end = markets[0]['analysisEndTime']
        
        metadata = {
            'total_markets': len(markets),
            'total_samples': len(timestamps),
            'config': {
                'downsample_interval_secs': config.downsample_interval_secs,
                'horizon_secs': config.horizon_secs,
                'p_min': config.p_min,
                'n_min': config.n_min,
                'ci_width_max': config.ci_width_max,
            }
        }
        
        payload = output_handler.create_payload(
            market_type=args.market_type,
            token_side=args.token_side,
            start_time=analysis_start,
            end_time=analysis_end,
            ranges=ranges,
            range_stats=range_stats,
            first_passage_results=fp_results,
            top_edges=top_edges,
            edge_summary=edge_summary,
            metadata=metadata
        )
        
        # Step 8: Save and cache
        print("\n[8/8] Saving and caching results...")
        
        if not args.no_save:
            filepath = output_handler.save_to_json(
                payload,
                args.market_type,
                analysis_start,
                analysis_end
            )
        
        if not args.no_cache:
            redis_key = output_handler.cache_to_redis(
                payload,
                args.market_type,
                analysis_start,
                analysis_end,
                args.token_side
            )
        
        print("\n" + "=" * 80)
        print("ANALYSIS COMPLETE")
        print("=" * 80)
        
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    finally:
        db.close_all()


if __name__ == '__main__':
    main()

