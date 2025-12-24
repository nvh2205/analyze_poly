export interface MarketData {
  market: string; // market_hash
  asset_id: string;
  timestamp: number;
  bids?: any[];
  asks?: any[];
  last_trade_price?: number;
}

export interface SocketMessage {
  event_type: string;
  market: string;
  asset_id: string;
  timestamp: number;
  price?: string;
  side?: string;
  size?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

export interface MarketApiResponse {
  id: string;
  question: string;
  slug: string;
  marketSlug: string;
  clobTokenIds: string | string[];
  startTime?: string;
  startDate?: string;
  start_time?: string;
  start_date?: string;
  eventStartTime?: string;
  endTime?: string;
  endDate?: string;
  end_time?: string;
  end_date?: string;
  events?: Array<{
    startTime?: string;
    startDate?: string;
    start_time?: string;
    start_date?: string;
    [key: string]: any;
  }>;
  tokens?: Array<{
    token_id: string;
    outcome: string;
  }>;
  token_yes?: string;
  token_no?: string;
  tokenYes?: string;
  tokenNo?: string;
  [key: string]: any;
}
