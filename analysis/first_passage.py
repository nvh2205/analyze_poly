"""First-passage probability analysis."""
import numpy as np
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict
from range_discovery import PriceRange
from range_analyzer import RangeAnalyzer
from config import config


def wilson_ci(successes: int, trials: int, confidence: float = 0.95) -> Tuple[float, float]:
    """
    Calculate Wilson score confidence interval for binomial proportion.
    
    Args:
        successes: Number of successes
        trials: Number of trials
        confidence: Confidence level (default 0.95)
    
    Returns:
        (lower_bound, upper_bound)
    """
    if trials == 0:
        return 0.0, 0.0
    
    from scipy import stats
    
    p = successes / trials
    z = stats.norm.ppf((1 + confidence) / 2)
    
    denominator = 1 + z**2 / trials
    center = (p + z**2 / (2 * trials)) / denominator
    margin = z * np.sqrt((p * (1 - p) / trials + z**2 / (4 * trials**2))) / denominator
    
    return max(0.0, center - margin), min(1.0, center + margin)


@dataclass
class FirstPassageResult:
    """Result of first-passage analysis for a range and direction."""
    range_idx: int
    range: PriceRange
    direction: str  # 'up' or 'down'
    
    # Target and stop ranges
    target_range_idx: Optional[int] = None
    stop_range_idx: Optional[int] = None
    
    # Statistics
    total_entries: int = 0
    hit_target_count: int = 0
    hit_stop_count: int = 0
    timeout_count: int = 0
    
    # Probabilities
    p_target: float = 0.0  # P(hit target before stop)
    p_stop: float = 0.0  # P(hit stop before target)
    p_timeout: float = 0.0  # P(timeout)
    
    # Confidence intervals
    ci_lower: float = 0.0
    ci_upper: float = 0.0
    ci_width: float = 0.0
    
    # Timing
    avg_time_to_target: float = 0.0  # Average time to hit target (seconds)
    avg_time_to_stop: float = 0.0  # Average time to hit stop (seconds)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        d = asdict(self)
        d['range'] = {'lo': self.range.lo, 'hi': self.range.hi}
        return d


class FirstPassageAnalyzer:
    """Analyzes first-passage probabilities."""
    
    def __init__(self):
        self.horizon_secs = config.horizon_secs
        self.analyzer = RangeAnalyzer()
    
    def get_adjacent_ranges(
        self,
        range_idx: int,
        ranges: List[PriceRange]
    ) -> Tuple[Optional[int], Optional[int]]:
        """
        Get adjacent ranges (target_up, stop_down).
        
        Args:
            range_idx: Current range index
            ranges: List of all ranges (sorted by center)
        
        Returns:
            (target_up_idx, stop_down_idx) or None if not available
        """
        # Sort ranges by center
        sorted_indices = sorted(range(len(ranges)), key=lambda i: ranges[i].center())
        
        # Find position of current range
        pos = sorted_indices.index(range_idx)
        
        target_up_idx = sorted_indices[pos + 1] if pos + 1 < len(sorted_indices) else None
        stop_down_idx = sorted_indices[pos - 1] if pos - 1 >= 0 else None
        
        return target_up_idx, stop_down_idx
    
    def analyze_entry(
        self,
        entry_idx: int,
        timestamps: np.ndarray,
        prices: np.ndarray,
        ranges: List[PriceRange],
        target_range_idx: int,
        stop_range_idx: int
    ) -> Tuple[str, float]:
        """
        Analyze single entry to determine outcome.
        
        Args:
            entry_idx: Index of entry
            timestamps: Timestamp array
            prices: Price array
            ranges: List of ranges
            target_range_idx: Target range index
            stop_range_idx: Stop range index
        
        Returns:
            (outcome, time_to_outcome) where outcome is 'target', 'stop', or 'timeout'
        """
        if entry_idx >= len(timestamps):
            return 'timeout', 0.0
        
        entry_time = timestamps[entry_idx]
        target_range = ranges[target_range_idx]
        stop_range = ranges[stop_range_idx]
        
        # Scan forward within horizon
        for i in range(entry_idx, len(timestamps)):
            elapsed = timestamps[i] - entry_time
            
            if elapsed > self.horizon_secs:
                return 'timeout', elapsed
            
            price = prices[i]
            
            # Check if hit target
            if target_range.contains(price):
                return 'target', elapsed
            
            # Check if hit stop
            if stop_range.contains(price):
                return 'stop', elapsed
        
        # Ran out of data
        elapsed = timestamps[-1] - entry_time if len(timestamps) > entry_idx else 0
        return 'timeout', elapsed
    
    def analyze_range_direction(
        self,
        range_idx: int,
        direction: str,
        timestamps: np.ndarray,
        prices: np.ndarray,
        ranges: List[PriceRange]
    ) -> Optional[FirstPassageResult]:
        """
        Analyze first-passage for a range in a specific direction.
        
        Args:
            range_idx: Range index
            direction: 'up' or 'down'
            timestamps: Timestamp array
            prices: Price array
            ranges: List of ranges
        
        Returns:
            FirstPassageResult or None
        """
        range_obj = ranges[range_idx]
        
        # Get adjacent ranges
        target_up_idx, stop_down_idx = self.get_adjacent_ranges(range_idx, ranges)
        
        if direction == 'up':
            target_idx = target_up_idx
            stop_idx = stop_down_idx
        else:  # down
            target_idx = stop_down_idx
            stop_idx = target_up_idx
        
        # Need both target and stop
        if target_idx is None or stop_idx is None:
            return None
        
        result = FirstPassageResult(
            range_idx=range_idx,
            range=range_obj,
            direction=direction,
            target_range_idx=target_idx,
            stop_range_idx=stop_idx
        )
        
        # Find all entries into this range
        entries = []
        current_range_idx = None
        
        for i in range(len(prices)):
            new_range_idx = self.analyzer.find_current_range(prices[i], ranges)
            
            if new_range_idx == range_idx and new_range_idx != current_range_idx:
                entries.append(i)
            
            current_range_idx = new_range_idx
        
        if len(entries) == 0:
            return result
        
        result.total_entries = len(entries)
        
        # Analyze each entry
        target_times = []
        stop_times = []
        
        for entry_idx in entries:
            outcome, time_elapsed = self.analyze_entry(
                entry_idx,
                timestamps,
                prices,
                ranges,
                target_idx,
                stop_idx
            )
            
            if outcome == 'target':
                result.hit_target_count += 1
                target_times.append(time_elapsed)
            elif outcome == 'stop':
                result.hit_stop_count += 1
                stop_times.append(time_elapsed)
            else:  # timeout
                result.timeout_count += 1
        
        # Compute probabilities
        if result.total_entries > 0:
            result.p_target = result.hit_target_count / result.total_entries
            result.p_stop = result.hit_stop_count / result.total_entries
            result.p_timeout = result.timeout_count / result.total_entries
        
        # Compute confidence interval
        result.ci_lower, result.ci_upper = wilson_ci(result.hit_target_count, result.total_entries)
        result.ci_width = result.ci_upper - result.ci_lower
        
        # Compute average times
        if len(target_times) > 0:
            result.avg_time_to_target = np.mean(target_times)
        if len(stop_times) > 0:
            result.avg_time_to_stop = np.mean(stop_times)
        
        return result
    
    def analyze_all_ranges(
        self,
        timestamps: np.ndarray,
        prices: np.ndarray,
        ranges: List[PriceRange]
    ) -> List[FirstPassageResult]:
        """
        Analyze first-passage for all ranges in both directions.
        
        Args:
            timestamps: Timestamp array
            prices: Price array
            ranges: List of ranges
        
        Returns:
            List of FirstPassageResult
        """
        print(f"Analyzing first-passage for {len(ranges)} ranges...")
        
        results = []
        
        for i, r in enumerate(ranges):
            # Analyze up direction
            result_up = self.analyze_range_direction(i, 'up', timestamps, prices, ranges)
            if result_up and result_up.total_entries > 0:
                results.append(result_up)
                print(f"  Range {i} {r} UP: p={result_up.p_target:.2f}, "
                      f"n={result_up.total_entries}, CI_width={result_up.ci_width:.3f}")
            
            # Analyze down direction
            result_down = self.analyze_range_direction(i, 'down', timestamps, prices, ranges)
            if result_down and result_down.total_entries > 0:
                results.append(result_down)
                print(f"  Range {i} {r} DOWN: p={result_down.p_target:.2f}, "
                      f"n={result_down.total_entries}, CI_width={result_down.ci_width:.3f}")
        
        print(f"First-passage analysis complete: {len(results)} setups")
        return results

