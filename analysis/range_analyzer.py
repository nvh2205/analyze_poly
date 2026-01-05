"""Range statistics: entries, dwell, hold, breakout, next-range."""
import numpy as np
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict
from collections import defaultdict
from range_discovery import PriceRange
from config import config


@dataclass
class RangeStats:
    """Statistics for a price range."""
    range: PriceRange
    
    # Basic stats
    entries: int = 0  # Number of times entered this range
    total_dwell_secs: float = 0.0  # Total time spent in range
    avg_dwell_secs: float = 0.0  # Average dwell time per entry
    
    # Hold stats
    hold_count: int = 0  # Number of times held >= threshold
    hold_percentage: float = 0.0  # % of entries that held
    
    # Breakout stats
    breakout_up_count: int = 0  # Breakouts upward
    breakout_down_count: int = 0  # Breakouts downward
    breakout_up_pct: float = 0.0
    breakout_down_pct: float = 0.0
    
    # Next range distribution (range_id -> count)
    next_range_after_breakout_up: Dict[int, int] = None
    next_range_after_breakout_down: Dict[int, int] = None
    
    def __post_init__(self):
        if self.next_range_after_breakout_up is None:
            self.next_range_after_breakout_up = {}
        if self.next_range_after_breakout_down is None:
            self.next_range_after_breakout_down = {}
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        d = asdict(self)
        d['range'] = {'lo': self.range.lo, 'hi': self.range.hi}
        return d


class RangeAnalyzer:
    """Analyzes range statistics from price time series."""
    
    def __init__(self):
        self.confirm_secs = config.confirm_secs
        self.hold_secs_threshold = config.hold_secs_threshold
    
    def find_current_range(
        self,
        price: int,
        ranges: List[PriceRange]
    ) -> Optional[int]:
        """
        Find which range contains the price.
        
        Args:
            price: Price in cents
            ranges: List of ranges
        
        Returns:
            Range index or None
        """
        for i, r in enumerate(ranges):
            if r.contains(price):
                return i
        return None
    
    def detect_breakout(
        self,
        timestamps: np.ndarray,
        prices: np.ndarray,
        start_idx: int,
        range_obj: PriceRange
    ) -> Tuple[Optional[str], int]:
        """
        Detect if breakout occurs from start_idx.
        
        Args:
            timestamps: Timestamp array
            prices: Price array
            start_idx: Starting index
            range_obj: Range to check breakout from
        
        Returns:
            (direction, confirm_idx) where:
            - direction: 'up', 'down', or None
            - confirm_idx: Index where breakout confirmed
        """
        if start_idx >= len(prices):
            return None, start_idx
        
        start_time = timestamps[start_idx]
        
        # Scan forward
        for i in range(start_idx, len(prices)):
            if timestamps[i] - start_time > self.confirm_secs:
                # Check if we've been outside range for confirm_secs
                # Look back to see if we've been consistently outside
                lookback_start = max(start_idx, i - self.confirm_secs)
                
                outside_up = True
                outside_down = True
                
                for j in range(lookback_start, i + 1):
                    if range_obj.contains(prices[j]):
                        outside_up = False
                        outside_down = False
                        break
                    
                    if prices[j] < range_obj.lo:
                        outside_up = False
                    elif prices[j] > range_obj.hi:
                        outside_down = False
                
                if outside_up:
                    return 'up', i
                elif outside_down:
                    return 'down', i
        
        return None, len(prices) - 1
    
    def analyze_ranges(
        self,
        timestamps: np.ndarray,
        prices: np.ndarray,
        ranges: List[PriceRange]
    ) -> List[RangeStats]:
        """
        Analyze all ranges and compute statistics.
        
        Args:
            timestamps: Unix seconds array
            prices: Price cents array
            ranges: List of ranges to analyze
        
        Returns:
            List of RangeStats
        """
        print(f"Analyzing {len(ranges)} ranges...")
        
        if len(timestamps) == 0 or len(ranges) == 0:
            return []
        
        # Initialize stats for each range
        stats = [RangeStats(range=r) for r in ranges]
        
        # Track current range and entry point
        current_range_idx = None
        entry_idx = None
        entry_time = None
        
        # Compute time differences
        time_diffs = np.diff(timestamps, prepend=timestamps[0])
        
        for i in range(len(prices)):
            price = prices[i]
            new_range_idx = self.find_current_range(price, ranges)
            
            # Check if we entered a new range
            if new_range_idx is not None and new_range_idx != current_range_idx:
                # We entered a new range
                stats[new_range_idx].entries += 1
                entry_idx = i
                entry_time = timestamps[i]
                
                # If we came from another range, record breakout
                if current_range_idx is not None:
                    # Determine direction
                    old_center = ranges[current_range_idx].center()
                    new_center = ranges[new_range_idx].center()
                    
                    if new_center > old_center:
                        # Breakout up from old range
                        stats[current_range_idx].breakout_up_count += 1
                        stats[current_range_idx].next_range_after_breakout_up[new_range_idx] = \
                            stats[current_range_idx].next_range_after_breakout_up.get(new_range_idx, 0) + 1
                    elif new_center < old_center:
                        # Breakout down from old range
                        stats[current_range_idx].breakout_down_count += 1
                        stats[current_range_idx].next_range_after_breakout_down[new_range_idx] = \
                            stats[current_range_idx].next_range_after_breakout_down.get(new_range_idx, 0) + 1
                
                current_range_idx = new_range_idx
            
            elif new_range_idx is None and current_range_idx is not None:
                # We left current range (into no-range territory)
                # Record dwell time
                if entry_idx is not None and entry_time is not None:
                    dwell_time = timestamps[i - 1] - entry_time if i > 0 else 0
                    stats[current_range_idx].total_dwell_secs += dwell_time
                    
                    # Check if it held
                    if dwell_time >= self.hold_secs_threshold:
                        stats[current_range_idx].hold_count += 1
                
                current_range_idx = None
                entry_idx = None
                entry_time = None
            
            # Accumulate dwell time if in range
            if current_range_idx is not None:
                stats[current_range_idx].total_dwell_secs += time_diffs[i]
        
        # Final dwell computation if still in a range
        if current_range_idx is not None and entry_time is not None:
            dwell_time = timestamps[-1] - entry_time
            if dwell_time >= self.hold_secs_threshold:
                stats[current_range_idx].hold_count += 1
        
        # Compute derived statistics
        for s in stats:
            if s.entries > 0:
                s.avg_dwell_secs = s.total_dwell_secs / s.entries
                s.hold_percentage = (s.hold_count / s.entries) * 100.0
                
                total_breakouts = s.breakout_up_count + s.breakout_down_count
                if total_breakouts > 0:
                    s.breakout_up_pct = (s.breakout_up_count / total_breakouts) * 100.0
                    s.breakout_down_pct = (s.breakout_down_count / total_breakouts) * 100.0
        
        print(f"Range analysis complete")
        for i, s in enumerate(stats):
            print(f"  Range {i} {s.range}: {s.entries} entries, "
                  f"{s.total_dwell_secs:.1f}s dwell, "
                  f"{s.breakout_up_count}↑ {s.breakout_down_count}↓")
        
        return stats

