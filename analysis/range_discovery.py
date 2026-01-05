"""Auto-range discovery from price time series."""
import numpy as np
from scipy.signal import find_peaks
from scipy.ndimage import uniform_filter1d
from typing import List, Tuple
from dataclasses import dataclass
from config import config


@dataclass
class PriceRange:
    """Represents a price range."""
    lo: int  # Lower bound (cents)
    hi: int  # Higher bound (cents)
    
    def __repr__(self):
        return f"[{self.lo}, {self.hi}]"
    
    def contains(self, price: int) -> bool:
        """Check if price is in range."""
        return self.lo <= price <= self.hi
    
    def center(self) -> float:
        """Get center of range."""
        return (self.lo + self.hi) / 2.0
    
    def width(self) -> int:
        """Get width of range."""
        return self.hi - self.lo + 1


class RangeDiscovery:
    """Discovers important price ranges from time series."""
    
    def __init__(self):
        self.bins = config.histogram_bins
        self.smoothing_window = config.smoothing_window
        self.peak_threshold_quantile = config.peak_threshold_quantile
        self.min_dwell_secs = config.min_dwell_secs
        self.min_entries = config.min_entries
    
    def compute_time_histogram(
        self,
        timestamps: np.ndarray,
        prices: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Compute time-spent histogram for each price bin.
        
        Args:
            timestamps: Unix seconds array
            prices: Price cents array (0..100)
        
        Returns:
            (bins, time_spent) where:
            - bins: Array of price bins (0..100)
            - time_spent: Seconds spent at each bin
        """
        if len(timestamps) == 0:
            return np.arange(self.bins), np.zeros(self.bins)
        
        # Calculate time deltas (seconds between samples)
        time_diffs = np.diff(timestamps, prepend=timestamps[0])
        
        # Build histogram of time spent at each price
        time_spent = np.zeros(self.bins)
        
        for i, price in enumerate(prices):
            if 0 <= price < self.bins:
                time_spent[price] += time_diffs[i]
        
        bins = np.arange(self.bins)
        return bins, time_spent
    
    def smooth_histogram(self, histogram: np.ndarray) -> np.ndarray:
        """
        Smooth histogram using moving average.
        
        Args:
            histogram: Raw histogram
        
        Returns:
            Smoothed histogram
        """
        if self.smoothing_window <= 1:
            return histogram
        
        return uniform_filter1d(
            histogram,
            size=self.smoothing_window,
            mode='nearest'
        )
    
    def find_peaks_and_valleys(
        self,
        histogram: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Find peaks and valleys in histogram.
        
        Args:
            histogram: Smoothed histogram
        
        Returns:
            (peak_indices, valley_indices)
        """
        # Find peaks
        threshold = np.quantile(histogram[histogram > 0], self.peak_threshold_quantile)
        peaks, _ = find_peaks(histogram, height=threshold)
        
        # Find valleys (peaks of inverted histogram)
        inverted = -histogram
        valleys, _ = find_peaks(inverted)
        
        return peaks, valleys
    
    def segment_ranges(
        self,
        histogram: np.ndarray,
        peaks: np.ndarray
    ) -> List[PriceRange]:
        """
        Segment price ranges around peaks.
        
        Args:
            histogram: Smoothed histogram
            peaks: Peak indices
        
        Returns:
            List of PriceRange objects
        """
        if len(peaks) == 0:
            return []
        
        ranges = []
        
        # Compute threshold for range boundaries
        threshold = np.mean(histogram[histogram > 0]) if np.any(histogram > 0) else 0
        
        for peak in peaks:
            # Expand left from peak
            lo = peak
            while lo > 0 and histogram[lo] > threshold:
                lo -= 1
            
            # Expand right from peak
            hi = peak
            while hi < len(histogram) - 1 and histogram[hi] > threshold:
                hi += 1
            
            # Create range (ensure lo <= hi)
            if lo <= hi:
                ranges.append(PriceRange(lo=int(lo), hi=int(hi)))
        
        return ranges
    
    def merge_overlapping_ranges(
        self,
        ranges: List[PriceRange]
    ) -> List[PriceRange]:
        """
        Merge overlapping or adjacent ranges.
        
        Args:
            ranges: List of ranges
        
        Returns:
            List of merged ranges
        """
        if len(ranges) == 0:
            return []
        
        # Sort by lower bound
        sorted_ranges = sorted(ranges, key=lambda r: r.lo)
        
        merged = [sorted_ranges[0]]
        
        for current in sorted_ranges[1:]:
            last = merged[-1]
            
            # Check if overlapping or adjacent (within 1 cent)
            if current.lo <= last.hi + 1:
                # Merge
                merged[-1] = PriceRange(
                    lo=last.lo,
                    hi=max(last.hi, current.hi)
                )
            else:
                merged.append(current)
        
        return merged
    
    def filter_ranges_by_stats(
        self,
        ranges: List[PriceRange],
        timestamps: np.ndarray,
        prices: np.ndarray
    ) -> List[PriceRange]:
        """
        Filter ranges by minimum dwell time and entry count.
        
        Args:
            ranges: List of ranges
            timestamps: Timestamp array
            prices: Price array
        
        Returns:
            Filtered list of ranges
        """
        filtered = []
        
        for r in ranges:
            # Count entries and dwell time
            in_range = np.array([r.contains(p) for p in prices])
            
            # Count transitions into range (entries)
            entries = np.sum(np.diff(in_range.astype(int), prepend=0) == 1)
            
            # Calculate dwell time
            if len(timestamps) > 0:
                time_diffs = np.diff(timestamps, prepend=timestamps[0])
                dwell_time = np.sum(time_diffs[in_range])
            else:
                dwell_time = 0
            
            # Filter
            if entries >= self.min_entries and dwell_time >= self.min_dwell_secs:
                filtered.append(r)
        
        return filtered
    
    def discover_ranges(
        self,
        timestamps: np.ndarray,
        prices: np.ndarray
    ) -> List[PriceRange]:
        """
        Discover important price ranges from time series.
        
        Args:
            timestamps: Unix seconds array
            prices: Price cents array
        
        Returns:
            List of discovered PriceRange objects
        """
        print(f"Discovering ranges from {len(timestamps)} samples...")
        
        # Step 1: Compute time histogram
        bins, time_spent = self.compute_time_histogram(timestamps, prices)
        print(f"Computed time histogram: max={np.max(time_spent):.1f}s, mean={np.mean(time_spent[time_spent>0]):.1f}s")
        
        # Step 2: Smooth histogram
        smoothed = self.smooth_histogram(time_spent)
        
        # Step 3: Find peaks
        peaks, valleys = self.find_peaks_and_valleys(smoothed)
        print(f"Found {len(peaks)} peaks, {len(valleys)} valleys")
        
        # Step 4: Segment ranges around peaks
        ranges = self.segment_ranges(smoothed, peaks)
        print(f"Segmented {len(ranges)} initial ranges")
        
        # Step 5: Merge overlapping ranges
        ranges = self.merge_overlapping_ranges(ranges)
        print(f"After merging: {len(ranges)} ranges")
        
        # Step 6: Filter by minimum stats
        ranges = self.filter_ranges_by_stats(ranges, timestamps, prices)
        print(f"After filtering: {len(ranges)} valid ranges")
        
        return ranges

