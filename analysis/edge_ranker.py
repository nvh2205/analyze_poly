"""Edge ranking and filtering."""
import numpy as np
from typing import List, Dict, Any
from dataclasses import dataclass, asdict
from first_passage import FirstPassageResult
from range_discovery import PriceRange
from config import config


@dataclass
class EdgeSetup:
    """Represents a trading edge setup."""
    range_idx: int
    range: PriceRange
    direction: str
    
    # First-passage stats
    p_target: float
    n_samples: int
    ci_lower: float
    ci_upper: float
    ci_width: float
    
    # Target and stop
    target_range_idx: int
    stop_range_idx: int
    reward_cents: int  # Distance to target
    risk_cents: int  # Distance to stop
    
    # Edge metrics
    expected_value: float  # EV in cents
    reward_risk_ratio: float
    sharpe_like: float  # (p - 0.5) / ci_width (higher = more confident edge)
    
    # Timing
    avg_time_to_target: float
    avg_time_to_stop: float
    
    # Overall score
    edge_score: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        d = asdict(self)
        d['range'] = {'lo': self.range.lo, 'hi': self.range.hi}
        return d


class EdgeRanker:
    """Ranks and filters edge setups."""
    
    def __init__(self):
        self.p_min = config.p_min
        self.n_min = config.n_min
        self.ci_width_max = config.ci_width_max
        self.top_k = config.top_k_edges
    
    def calculate_edge_metrics(
        self,
        fp_result: FirstPassageResult,
        ranges: List[PriceRange]
    ) -> EdgeSetup:
        """
        Calculate edge metrics from first-passage result.
        
        Args:
            fp_result: First-passage result
            ranges: List of all ranges
        
        Returns:
            EdgeSetup
        """
        # Calculate distances
        entry_center = fp_result.range.center()
        target_center = ranges[fp_result.target_range_idx].center()
        stop_center = ranges[fp_result.stop_range_idx].center()
        
        reward_cents = int(abs(target_center - entry_center))
        risk_cents = int(abs(entry_center - stop_center))
        
        # Avoid division by zero
        if risk_cents == 0:
            risk_cents = 1
        
        # Calculate EV
        p = fp_result.p_target
        expected_value = p * reward_cents - (1 - p) * risk_cents
        
        # Calculate reward/risk ratio
        reward_risk_ratio = reward_cents / risk_cents if risk_cents > 0 else 0.0
        
        # Calculate Sharpe-like metric (confidence of edge)
        sharpe_like = (p - 0.5) / fp_result.ci_width if fp_result.ci_width > 0 else 0.0
        
        # Calculate overall edge score (weighted combination)
        # Higher is better
        edge_score = (
            expected_value * 1.0 +  # Raw EV
            reward_risk_ratio * 5.0 +  # Reward/risk bonus
            sharpe_like * 10.0 +  # Confidence bonus
            (p - 0.5) * 50.0  # Probability advantage
        )
        
        return EdgeSetup(
            range_idx=fp_result.range_idx,
            range=fp_result.range,
            direction=fp_result.direction,
            p_target=fp_result.p_target,
            n_samples=fp_result.total_entries,
            ci_lower=fp_result.ci_lower,
            ci_upper=fp_result.ci_upper,
            ci_width=fp_result.ci_width,
            target_range_idx=fp_result.target_range_idx,
            stop_range_idx=fp_result.stop_range_idx,
            reward_cents=reward_cents,
            risk_cents=risk_cents,
            expected_value=expected_value,
            reward_risk_ratio=reward_risk_ratio,
            sharpe_like=sharpe_like,
            avg_time_to_target=fp_result.avg_time_to_target,
            avg_time_to_stop=fp_result.avg_time_to_stop,
            edge_score=edge_score
        )
    
    def filter_edge(self, edge: EdgeSetup) -> bool:
        """
        Check if edge passes filters.
        
        Args:
            edge: EdgeSetup to check
        
        Returns:
            True if edge passes all filters
        """
        # Filter criteria
        if edge.p_target < self.p_min:
            return False
        
        if edge.n_samples < self.n_min:
            return False
        
        if edge.ci_width > self.ci_width_max:
            return False
        
        # Edge must be positive EV
        if edge.expected_value <= 0:
            return False
        
        return True
    
    def rank_edges(
        self,
        fp_results: List[FirstPassageResult],
        ranges: List[PriceRange]
    ) -> List[EdgeSetup]:
        """
        Rank and filter edge setups.
        
        Args:
            fp_results: List of first-passage results
            ranges: List of ranges
        
        Returns:
            Sorted list of top edge setups
        """
        print(f"Ranking {len(fp_results)} first-passage setups...")
        
        # Calculate edge metrics for all
        edges = []
        for fp in fp_results:
            edge = self.calculate_edge_metrics(fp, ranges)
            edges.append(edge)
        
        # Filter
        filtered_edges = [e for e in edges if self.filter_edge(e)]
        print(f"After filtering: {len(filtered_edges)} edges (p>={self.p_min}, n>={self.n_min}, CI<={self.ci_width_max})")
        
        # Sort by edge score (descending)
        sorted_edges = sorted(filtered_edges, key=lambda e: e.edge_score, reverse=True)
        
        # Take top K
        top_edges = sorted_edges[:self.top_k]
        
        print(f"\nTop {len(top_edges)} edges:")
        for i, e in enumerate(top_edges[:10]):  # Show top 10
            print(f"  {i+1}. Range {e.range} {e.direction}: "
                  f"p={e.p_target:.2%}, EV={e.expected_value:.1f}¢, "
                  f"R/R={e.reward_risk_ratio:.2f}, n={e.n_samples}, "
                  f"score={e.edge_score:.1f}")
        
        return top_edges
    
    def get_summary_stats(self, edges: List[EdgeSetup]) -> Dict[str, Any]:
        """
        Get summary statistics for edges.
        
        Args:
            edges: List of edges
        
        Returns:
            Summary dict
        """
        if len(edges) == 0:
            return {
                'total_edges': 0,
                'avg_p_target': 0.0,
                'avg_ev': 0.0,
                'avg_reward_risk': 0.0,
                'avg_samples': 0,
            }
        
        return {
            'total_edges': len(edges),
            'avg_p_target': np.mean([e.p_target for e in edges]),
            'avg_ev': np.mean([e.expected_value for e in edges]),
            'avg_reward_risk': np.mean([e.reward_risk_ratio for e in edges]),
            'avg_samples': int(np.mean([e.n_samples for e in edges])),
            'max_ev': np.max([e.expected_value for e in edges]),
            'max_p_target': np.max([e.p_target for e in edges]),
        }

