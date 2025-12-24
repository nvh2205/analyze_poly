# Polymarket Data Ingestion System Design

## 1. Tổng quan Kiến trúc

### 1.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              POLYMARKET DATA PIPELINE                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────────────┐     ┌──────────────────────────────────────────────────┐  │
│  │  POLYMARKET API  │     │              WEBSOCKET ENDPOINTS                  │  │
│  │  gamma-api.poly  │     │  wss://ws-subscriptions-clob.polymarket.com       │  │
│  └────────┬─────────┘     └────────────────────┬─────────────────────────────┘  │
│           │                                     │                                │
│           ▼                                     ▼                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        GO WEBSOCKET HANDLERS                             │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │    │
│  │  │  Handler 1  │  │  Handler 2  │  │  Handler 3  │  │  Handler N  │     │    │
│  │  │  50 tokens  │  │  50 tokens  │  │  50 tokens  │  │  50 tokens  │     │    │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │    │
│  │         │                │                │                │            │    │
│  │         └────────────────┴────────────────┴────────────────┘            │    │
│  │                                   │                                      │    │
│  │                          ┌───────▼────────┐                             │    │
│  │                          │  Rate Limiter  │                             │    │
│  │                          │  + Validator   │                             │    │
│  │                          └───────┬────────┘                             │    │
│  └──────────────────────────────────┼──────────────────────────────────────┘    │
│                                     │                                            │
│                                     ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                          KAFKA CLUSTER                                   │    │
│  │                                                                          │    │
│  │   ┌────────────────────────┐     ┌────────────────────────┐             │    │
│  │   │   orderbook-updates    │     │   market-activities    │             │    │
│  │   │   Partitions: 12       │     │   Partitions: 12       │             │    │
│  │   │   Retention: 7 days    │     │   Retention: 30 days   │             │    │
│  │   └───────────┬────────────┘     └───────────┬────────────┘             │    │
│  │               │                               │                          │    │
│  └───────────────┼───────────────────────────────┼──────────────────────────┘    │
│                  │                               │                               │
│                  ▼                               ▼                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         CONSUMER GROUPS                                  │    │
│  │                                                                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │  DB Writer      │  │  Aggregator     │  │  Alert Engine   │          │    │
│  │  │  (Go/Rust)      │  │  (Flink/Go)     │  │  (Go)           │          │    │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │    │
│  └───────────┼────────────────────┼────────────────────┼────────────────────┘    │
│              │                    │                    │                         │
│              ▼                    ▼                    ▼                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         STORAGE LAYER                                    │    │
│  │                                                                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │   TimescaleDB   │  │    ClickHouse   │  │     Redis       │          │    │
│  │  │   (Hot Data)    │  │   (Analytics)   │  │    (Cache)      │          │    │
│  │  │   7 days        │  │   Historical    │  │   Real-time     │          │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘          │    │
│  │                                                                          │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DATA FLOW                                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  1. DISCOVERY FLOW                                                               │
│  ────────────────                                                                │
│                                                                                  │
│  ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │ Cron    │───▶│ API Call │───▶│ Parse    │───▶│ Redis    │───▶│ Activate │   │
│  │ 15 min  │    │ /markets │    │ Tokens   │    │ Store    │    │ Sockets  │   │
│  └─────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
│                                                                                  │
│  2. INGESTION FLOW                                                               │
│  ─────────────────                                                               │
│                                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ WebSocket│───▶│ Validate │───▶│ Transform│───▶│ Kafka    │───▶│ Consumer │  │
│  │ Message  │    │ & Filter │    │ & Enrich │    │ Produce  │    │ Groups   │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│                                                                                  │
│  3. DEACTIVATION FLOW                                                            │
│  ────────────────────                                                            │
│                                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Market   │───▶│ Check    │───▶│ Close    │───▶│ Remove   │───▶│ Archive  │  │
│  │ Expired  │    │ endDate  │    │ Socket   │    │ Redis    │    │ Data     │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Discovery & Activation

### 2.1 Market Discovery Service

```go
// market_discovery.go
package discovery

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
    "go.uber.org/zap"
)

type MarketDiscoveryService struct {
    httpClient    *http.Client
    redis         *redis.Client
    socketManager *SocketManager
    logger        *zap.Logger
    slugConfigs   []SlugConfig
    
    mu            sync.RWMutex
    activeTokens  map[string]bool
}

type SlugConfig struct {
    Pattern   string `json:"pattern"`   // timestamp, datetime, daily
    BaseSlug  string `json:"baseSlug"`
    Interval  string `json:"interval"`  // 15m, 1h, 4h, daily
    Crypto    string `json:"crypto"`
}

type MarketResponse struct {
    ID            string   `json:"id"`
    Slug          string   `json:"slug"`
    ClobTokenIds  []string `json:"clobTokenIds"`
    Active        bool     `json:"active"`
    Closed        bool     `json:"closed"`
    EndDate       string   `json:"endDate"`
    Volume        string   `json:"volume"`
}

func NewMarketDiscoveryService(
    redis *redis.Client,
    socketManager *SocketManager,
    logger *zap.Logger,
) *MarketDiscoveryService {
    return &MarketDiscoveryService{
        httpClient: &http.Client{
            Timeout: 10 * time.Second,
        },
        redis:         redis,
        socketManager: socketManager,
        logger:        logger,
        activeTokens:  make(map[string]bool),
        slugConfigs:   loadSlugConfigs(),
    }
}

// StartDiscoveryLoop - Runs discovery every 15 minutes
func (s *MarketDiscoveryService) StartDiscoveryLoop(ctx context.Context) {
    ticker := time.NewTicker(15 * time.Minute)
    defer ticker.Stop()

    // Initial discovery
    s.runDiscovery(ctx)

    for {
        select {
        case <-ctx.Done():
            s.logger.Info("Discovery loop stopped")
            return
        case <-ticker.C:
            s.runDiscovery(ctx)
        }
    }
}

func (s *MarketDiscoveryService) runDiscovery(ctx context.Context) {
    s.logger.Info("Starting market discovery...")
    
    var wg sync.WaitGroup
    results := make(chan DiscoveryResult, len(s.slugConfigs)*3)

    for _, config := range s.slugConfigs {
        for offset := 0; offset < 3; offset++ {
            wg.Add(1)
            go func(cfg SlugConfig, off int) {
                defer wg.Done()
                result := s.discoverMarket(ctx, cfg, off)
                results <- result
            }(config, offset)
        }
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    // Process results
    var newTokens []string
    for result := range results {
        if result.Error != nil {
            s.logger.Error("Discovery error", 
                zap.String("slug", result.Slug),
                zap.Error(result.Error))
            continue
        }
        newTokens = append(newTokens, result.NewTokens...)
    }

    // Subscribe to new tokens
    if len(newTokens) > 0 {
        s.logger.Info("Found new tokens", zap.Int("count", len(newTokens)))
        s.socketManager.SubscribeToTokens(newTokens)
    }
}

func (s *MarketDiscoveryService) discoverMarket(
    ctx context.Context, 
    config SlugConfig, 
    offset int,
) DiscoveryResult {
    slug := generateSlugWithOffset(config, offset)
    
    // Check cache
    cached, _ := s.redis.Get(ctx, fmt.Sprintf("market_info:%s", slug)).Result()
    if cached != "" {
        return DiscoveryResult{Slug: slug, Cached: true}
    }

    // Fetch from API
    url := fmt.Sprintf("https://gamma-api.polymarket.com/markets?slug=%s", slug)
    resp, err := s.httpClient.Get(url)
    if err != nil {
        return DiscoveryResult{Slug: slug, Error: err}
    }
    defer resp.Body.Close()

    if resp.StatusCode == 404 {
        return DiscoveryResult{Slug: slug}
    }

    var markets []MarketResponse
    if err := json.NewDecoder(resp.Body).Decode(&markets); err != nil {
        return DiscoveryResult{Slug: slug, Error: err}
    }

    if len(markets) == 0 {
        return DiscoveryResult{Slug: slug}
    }

    market := markets[0]
    
    // Filter new tokens
    newTokens := s.filterNewTokens(ctx, market.ClobTokenIds)
    
    // Store in Redis
    if len(newTokens) > 0 {
        s.storeTokenMetadata(ctx, newTokens, slug, config)
    }

    // Cache market info
    marketJson, _ := json.Marshal(market)
    s.redis.Set(ctx, fmt.Sprintf("market_info:%s", slug), marketJson, 30*time.Minute)

    return DiscoveryResult{
        Slug:      slug,
        NewTokens: newTokens,
    }
}

func (s *MarketDiscoveryService) filterNewTokens(ctx context.Context, tokenIds []string) []string {
    var newTokens []string
    
    for _, tokenId := range tokenIds {
        s.mu.RLock()
        exists := s.activeTokens[tokenId]
        s.mu.RUnlock()
        
        if !exists {
            // Double check with Redis
            isMember, _ := s.redis.SIsMember(ctx, "active_clob_tokens", tokenId).Result()
            if !isMember {
                newTokens = append(newTokens, tokenId)
                
                s.mu.Lock()
                s.activeTokens[tokenId] = true
                s.mu.Unlock()
            }
        }
    }
    
    return newTokens
}
```

### 2.2 Market Cleanup Service

```go
// market_cleanup.go
package discovery

import (
    "context"
    "time"

    "go.uber.org/zap"
)

type MarketCleanupService struct {
    redis         *redis.Client
    db            *sql.DB
    socketManager *SocketManager
    logger        *zap.Logger
}

// StartCleanupLoop - Runs every 15 minutes to check expired markets
func (s *MarketCleanupService) StartCleanupLoop(ctx context.Context) {
    ticker := time.NewTicker(15 * time.Minute)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            s.cleanupExpiredMarkets(ctx)
        }
    }
}

func (s *MarketCleanupService) cleanupExpiredMarkets(ctx context.Context) {
    s.logger.Info("Starting expired markets cleanup...")

    // Query expired markets from DB
    rows, err := s.db.QueryContext(ctx, `
        SELECT id, market_id, slug, clob_token_ids 
        FROM markets 
        WHERE active = true 
        AND end_date < NOW()
    `)
    if err != nil {
        s.logger.Error("Failed to query expired markets", zap.Error(err))
        return
    }
    defer rows.Close()

    var expiredTokens []string
    var marketIds []string

    for rows.Next() {
        var id, marketId, slug string
        var tokenIds []string
        
        if err := rows.Scan(&id, &marketId, &slug, &tokenIds); err != nil {
            continue
        }

        marketIds = append(marketIds, id)
        expiredTokens = append(expiredTokens, tokenIds...)
    }

    if len(expiredTokens) == 0 {
        s.logger.Debug("No expired markets found")
        return
    }

    s.logger.Info("Found expired markets", 
        zap.Int("markets", len(marketIds)),
        zap.Int("tokens", len(expiredTokens)))

    // Unsubscribe from expired tokens
    s.socketManager.UnsubscribeFromTokens(expiredTokens)

    // Update database
    _, err = s.db.ExecContext(ctx, `
        UPDATE markets 
        SET active = false, closed = true, updated_at = NOW()
        WHERE id = ANY($1)
    `, marketIds)
    if err != nil {
        s.logger.Error("Failed to update market status", zap.Error(err))
    }

    // Remove from Redis
    s.redis.SRem(ctx, "active_clob_tokens", expiredTokens)
    
    for _, tokenId := range expiredTokens {
        s.redis.Del(ctx, fmt.Sprintf("token_metadata:%s", tokenId))
    }

    s.logger.Info("Cleanup completed",
        zap.Int("closed_markets", len(marketIds)),
        zap.Int("removed_tokens", len(expiredTokens)))
}
```

---

## 3. Realtime Ingestion (Go WebSocket Handler)

### 3.1 Socket Manager

```go
// socket_manager.go
package ingestion

import (
    "context"
    "encoding/json"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "github.com/segmentio/kafka-go"
    "go.uber.org/zap"
)

const (
    MaxTokensPerSocket = 50
    PingInterval       = 10 * time.Second
    WriteTimeout       = 10 * time.Second
    ReadTimeout        = 60 * time.Second
    MaxReconnectDelay  = 30 * time.Second
    BaseReconnectDelay = 1 * time.Second
)

type SocketManager struct {
    logger       *zap.Logger
    kafkaWriter  *kafka.Writer
    
    mu           sync.RWMutex
    connections  map[string]*SocketConnection
    tokenToConn  map[string]string // token -> connectionId
    
    ctx          context.Context
    cancel       context.CancelFunc
}

type SocketConnection struct {
    ID               string
    WS               *websocket.Conn
    Tokens           []string
    ReconnectAttempt int
    LastPong         time.Time
    
    mu               sync.Mutex
    closed           bool
    stopChan         chan struct{}
}

type SocketMessage struct {
    EventType string                   `json:"event_type"`
    Market    string                   `json:"market"`
    AssetID   string                   `json:"asset_id"`
    Timestamp int64                    `json:"timestamp"`
    Price     string                   `json:"price,omitempty"`
    Side      string                   `json:"side,omitempty"`
    Size      string                   `json:"size,omitempty"`
    Bids      []map[string]interface{} `json:"bids,omitempty"`
    Asks      []map[string]interface{} `json:"asks,omitempty"`
}

func NewSocketManager(kafkaWriter *kafka.Writer, logger *zap.Logger) *SocketManager {
    ctx, cancel := context.WithCancel(context.Background())
    return &SocketManager{
        logger:      logger,
        kafkaWriter: kafkaWriter,
        connections: make(map[string]*SocketConnection),
        tokenToConn: make(map[string]string),
        ctx:         ctx,
        cancel:      cancel,
    }
}

// SubscribeToTokens - Subscribe to new tokens (with chunking)
func (sm *SocketManager) SubscribeToTokens(tokenIds []string) {
    sm.mu.Lock()
    defer sm.mu.Unlock()

    // Filter out already subscribed tokens
    var newTokens []string
    for _, tokenId := range tokenIds {
        if _, exists := sm.tokenToConn[tokenId]; !exists {
            newTokens = append(newTokens, tokenId)
        }
    }

    if len(newTokens) == 0 {
        return
    }

    sm.logger.Info("Subscribing to new tokens", zap.Int("count", len(newTokens)))

    // Chunk tokens
    chunks := chunkSlice(newTokens, MaxTokensPerSocket)

    for i, chunk := range chunks {
        connID := fmt.Sprintf("socket-%d-%d", time.Now().UnixNano(), i)
        go sm.createConnection(connID, chunk)
        time.Sleep(100 * time.Millisecond) // Avoid overwhelming server
    }
}

// UnsubscribeFromTokens - Unsubscribe and close relevant connections
func (sm *SocketManager) UnsubscribeFromTokens(tokenIds []string) {
    sm.mu.Lock()
    defer sm.mu.Unlock()

    // Find connections containing these tokens
    connsToClose := make(map[string]bool)
    for _, tokenId := range tokenIds {
        if connID, exists := sm.tokenToConn[tokenId]; exists {
            connsToClose[connID] = true
            delete(sm.tokenToConn, tokenId)
        }
    }

    // Close affected connections
    for connID := range connsToClose {
        if conn, exists := sm.connections[connID]; exists {
            sm.logger.Info("Closing connection due to token expiry",
                zap.String("connID", connID),
                zap.Int("tokens", len(conn.Tokens)))
            conn.Close()
            delete(sm.connections, connID)
        }
    }
}

func (sm *SocketManager) createConnection(connID string, tokens []string) {
    conn := &SocketConnection{
        ID:       connID,
        Tokens:   tokens,
        stopChan: make(chan struct{}),
    }

    sm.mu.Lock()
    sm.connections[connID] = conn
    for _, token := range tokens {
        sm.tokenToConn[token] = connID
    }
    sm.mu.Unlock()

    sm.connectAndListen(conn)
}

func (sm *SocketManager) connectAndListen(conn *SocketConnection) {
    for {
        select {
        case <-sm.ctx.Done():
            return
        case <-conn.stopChan:
            return
        default:
        }

        // Calculate backoff delay
        delay := time.Duration(1<<uint(conn.ReconnectAttempt)) * BaseReconnectDelay
        if delay > MaxReconnectDelay {
            delay = MaxReconnectDelay
        }

        if conn.ReconnectAttempt > 0 {
            sm.logger.Info("Reconnecting...",
                zap.String("connID", conn.ID),
                zap.Int("attempt", conn.ReconnectAttempt),
                zap.Duration("delay", delay))
            time.Sleep(delay)
        }

        // Connect
        ws, _, err := websocket.DefaultDialer.Dial(
            "wss://ws-subscriptions-clob.polymarket.com/ws/market",
            nil,
        )
        if err != nil {
            sm.logger.Error("WebSocket connection failed",
                zap.String("connID", conn.ID),
                zap.Error(err))
            conn.ReconnectAttempt++
            continue
        }

        conn.mu.Lock()
        conn.WS = ws
        conn.ReconnectAttempt = 0
        conn.LastPong = time.Now()
        conn.mu.Unlock()

        // Send subscription message
        subscribeMsg := map[string]interface{}{
            "assets_ids": conn.Tokens,
            "type":       "market",
        }
        if err := ws.WriteJSON(subscribeMsg); err != nil {
            sm.logger.Error("Failed to send subscription",
                zap.String("connID", conn.ID),
                zap.Error(err))
            ws.Close()
            conn.ReconnectAttempt++
            continue
        }

        sm.logger.Info("WebSocket connected",
            zap.String("connID", conn.ID),
            zap.Int("tokens", len(conn.Tokens)))

        // Start ping routine
        go sm.pingRoutine(conn)

        // Read messages
        sm.readMessages(conn)

        // If we get here, connection was closed
        if conn.closed {
            return
        }
        conn.ReconnectAttempt++
    }
}

func (sm *SocketManager) readMessages(conn *SocketConnection) {
    for {
        conn.WS.SetReadDeadline(time.Now().Add(ReadTimeout))
        
        _, message, err := conn.WS.ReadMessage()
        if err != nil {
            if !conn.closed {
                sm.logger.Warn("WebSocket read error",
                    zap.String("connID", conn.ID),
                    zap.Error(err))
            }
            return
        }

        // Skip ping/pong
        msgStr := string(message)
        if msgStr == "PONG" || msgStr == "PING" {
            continue
        }

        // Parse and validate message
        var msg SocketMessage
        if err := json.Unmarshal(message, &msg); err != nil {
            continue
        }

        // Filter: only process book and last_trade events
        if msg.EventType != "book" && msg.EventType != "last_trade" {
            continue
        }

        // Publish to Kafka
        go sm.publishToKafka(msg)
    }
}

func (sm *SocketManager) publishToKafka(msg SocketMessage) {
    data, err := json.Marshal(msg)
    if err != nil {
        return
    }

    // Determine topic based on event type
    topic := "orderbook-updates"
    if msg.EventType == "last_trade" {
        topic = "market-activities"
    }

    err = sm.kafkaWriter.WriteMessages(sm.ctx, kafka.Message{
        Topic: topic,
        Key:   []byte(msg.AssetID),
        Value: data,
        Time:  time.Now(),
    })
    if err != nil {
        sm.logger.Error("Failed to publish to Kafka",
            zap.String("topic", topic),
            zap.Error(err))
    }
}

func (sm *SocketManager) pingRoutine(conn *SocketConnection) {
    ticker := time.NewTicker(PingInterval)
    defer ticker.Stop()

    for {
        select {
        case <-conn.stopChan:
            return
        case <-ticker.C:
            conn.mu.Lock()
            if conn.WS != nil && !conn.closed {
                conn.WS.SetWriteDeadline(time.Now().Add(WriteTimeout))
                if err := conn.WS.WriteMessage(websocket.PingMessage, nil); err != nil {
                    sm.logger.Warn("Ping failed", zap.String("connID", conn.ID))
                }
            }
            conn.mu.Unlock()
        }
    }
}

func (conn *SocketConnection) Close() {
    conn.mu.Lock()
    defer conn.mu.Unlock()
    
    if conn.closed {
        return
    }
    
    conn.closed = true
    close(conn.stopChan)
    
    if conn.WS != nil {
        conn.WS.Close()
    }
}

// Shutdown - Gracefully shutdown all connections
func (sm *SocketManager) Shutdown() {
    sm.cancel()
    
    sm.mu.Lock()
    defer sm.mu.Unlock()
    
    for _, conn := range sm.connections {
        conn.Close()
    }
    
    sm.logger.Info("Socket manager shutdown complete")
}

func chunkSlice(slice []string, chunkSize int) [][]string {
    var chunks [][]string
    for i := 0; i < len(slice); i += chunkSize {
        end := i + chunkSize
        if end > len(slice) {
            end = len(slice)
        }
        chunks = append(chunks, slice[i:end])
    }
    return chunks
}
```

---

## 4. Event Bus - Kafka Configuration

### 4.1 Topic Design

```yaml
# kafka-topics.yaml
topics:
  # Orderbook updates - high frequency, short retention
  - name: orderbook-updates
    partitions: 12
    replication_factor: 3
    configs:
      retention.ms: 604800000          # 7 days
      cleanup.policy: delete
      min.insync.replicas: 2
      compression.type: lz4
      max.message.bytes: 1048576       # 1MB
      segment.ms: 3600000              # 1 hour
      
  # Market activities (trades, fills) - append-only, longer retention
  - name: market-activities
    partitions: 12
    replication_factor: 3
    configs:
      retention.ms: 2592000000         # 30 days
      cleanup.policy: delete
      min.insync.replicas: 2
      compression.type: lz4
      
  # Market state changes (open/close/update)
  - name: market-state
    partitions: 6
    replication_factor: 3
    configs:
      retention.ms: -1                 # Infinite
      cleanup.policy: compact
      min.compaction.lag.ms: 3600000   # 1 hour
```

### 4.2 Partitioning Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PARTITIONING STRATEGY                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  KEY: asset_id (token_id)                                               │
│  ─────────────────────────                                               │
│  - Ensures all messages for same token go to same partition             │
│  - Maintains ordering per token                                          │
│  - Enables parallel processing across different tokens                   │
│                                                                          │
│  ┌──────────────────┐                                                   │
│  │   orderbook-updates                                                  │
│  │   ────────────────                                                   │
│  │   Partition 0: token_abc, token_xyz                                  │
│  │   Partition 1: token_def, token_uvw                                  │
│  │   Partition 2: token_ghi, token_rst                                  │
│  │   ...                                                                 │
│  │   Partition 11: token_jkl, token_opq                                 │
│  └──────────────────┘                                                   │
│                                                                          │
│  CONSUMER GROUP STRATEGY                                                │
│  ───────────────────────                                                │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Consumer Group: db-writer                                       │   │
│  │  ─────────────────────────                                       │   │
│  │  - 12 consumers (1 per partition)                               │   │
│  │  - At-least-once semantics with idempotent writes               │   │
│  │  - Manual offset commit after successful DB write               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Consumer Group: aggregator                                      │   │
│  │  ──────────────────────────                                      │   │
│  │  - 6 consumers (for lower throughput aggregation)               │   │
│  │  - Computes VWAP, depth snapshots                               │   │
│  │  - Writes to Redis for real-time access                         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Consumer Group: alerting                                        │   │
│  │  ────────────────────────                                        │   │
│  │  - 3 consumers                                                   │   │
│  │  - Real-time spread alerts, volume spikes                       │   │
│  │  - Low latency requirement                                       │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Kafka Producer Config (Go)

```go
// kafka_producer.go
package kafka

import (
    "time"
    
    "github.com/segmentio/kafka-go"
)

func NewKafkaWriter(brokers []string, topic string) *kafka.Writer {
    return &kafka.Writer{
        Addr:         kafka.TCP(brokers...),
        Topic:        topic,
        Balancer:     &kafka.Hash{}, // Partition by key (asset_id)
        MaxAttempts:  3,
        BatchSize:    100,
        BatchBytes:   1048576, // 1MB
        BatchTimeout: 10 * time.Millisecond,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
        RequiredAcks: kafka.RequireOne, // Trade-off: speed vs durability
        Async:        false, // Sync for reliability
        Compression:  kafka.Lz4,
    }
}

// For at-least-once semantics with higher durability
func NewKafkaWriterReliable(brokers []string, topic string) *kafka.Writer {
    return &kafka.Writer{
        Addr:         kafka.TCP(brokers...),
        Topic:        topic,
        Balancer:     &kafka.Hash{},
        MaxAttempts:  5,
        BatchSize:    50,
        BatchTimeout: 50 * time.Millisecond,
        RequiredAcks: kafka.RequireAll, // Wait for all replicas
        Async:        false,
        Compression:  kafka.Lz4,
    }
}
```

---

## 5. Storage Layer

### 5.1 Database Comparison

| Feature | TimescaleDB | ClickHouse | Cassandra | Redis |
|---------|-------------|------------|-----------|-------|
| **Use Case** | Hot data, time-series | Analytics, aggregations | High write throughput | Real-time cache |
| **Write Speed** | ~50K rows/s | ~500K rows/s | ~100K rows/s | ~1M ops/s |
| **Query Pattern** | Time-range + aggregations | OLAP, columnar scan | Key-value, wide columns | Key-value, pub/sub |
| **Compression** | Good (70-90%) | Excellent (90-95%) | Good | N/A |
| **SQL Support** | Full PostgreSQL | ClickHouse SQL | CQL (limited) | No |
| **Scaling** | Vertical + Hypertables | Horizontal (shards) | Horizontal (ring) | Cluster mode |
| **Cost** | Medium | Low (storage efficient) | Medium | High (memory) |

### 5.2 Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    HYBRID STORAGE ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      HOT TIER (0-7 days)                         │   │
│  │                                                                   │   │
│  │  ┌─────────────────┐    ┌─────────────────┐                     │   │
│  │  │  TimescaleDB    │    │     Redis       │                     │   │
│  │  │  ─────────────  │    │  ───────────    │                     │   │
│  │  │  • Orderbooks   │    │  • Latest state │                     │   │
│  │  │  • Activities   │    │  • VWAP cache   │                     │   │
│  │  │  • Markets      │    │  • Active tokens│                     │   │
│  │  │  • 7-day window │    │  • Alerts queue │                     │   │
│  │  └─────────────────┘    └─────────────────┘                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼ (After 7 days)                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     COLD TIER (7+ days)                          │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │                     ClickHouse                           │    │   │
│  │  │  ───────────────────────────────────────                 │    │   │
│  │  │  • Historical orderbook snapshots                        │    │   │
│  │  │  • Trade history (activities)                            │    │   │
│  │  │  • Aggregated metrics (hourly, daily)                    │    │   │
│  │  │  • Backtesting data                                      │    │   │
│  │  │  • Compressed columnar storage                           │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼ (After 90 days)                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    ARCHIVE TIER (90+ days)                       │   │
│  │                                                                   │
│  │  ┌─────────────────────────────────────────────────────────┐    │   │
│  │  │                   Object Storage (S3/GCS)                │    │   │
│  │  │  ─────────────────────────────────────                   │    │   │
│  │  │  • Parquet files (daily partitions)                      │    │   │
│  │  │  • Queryable via Athena/BigQuery                         │    │   │
│  │  │  • Long-term retention (years)                           │    │   │
│  │  └─────────────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.3 TimescaleDB Schema

```sql
-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Markets table (regular PostgreSQL)
CREATE TABLE markets (
    id BIGSERIAL PRIMARY KEY,
    market_id VARCHAR(255) UNIQUE NOT NULL,
    question TEXT,
    condition_id VARCHAR(255),
    slug VARCHAR(500) UNIQUE NOT NULL,
    volume DECIMAL(20, 10),
    active BOOLEAN DEFAULT true,
    closed BOOLEAN DEFAULT false,
    question_id VARCHAR(255),
    clob_token_ids JSONB,
    creation_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_markets_active ON markets(active) WHERE active = true;
CREATE INDEX idx_markets_end_date ON markets(end_date) WHERE active = true;

-- Orderbook snapshots (TimescaleDB hypertable)
CREATE TABLE market_orderbooks (
    time TIMESTAMPTZ NOT NULL,
    market_hash VARCHAR(66) NOT NULL,
    asset_id VARCHAR(255) NOT NULL,
    slug VARCHAR(500),
    market_id BIGINT REFERENCES markets(id),
    bids JSONB,
    asks JSONB,
    best_bid DECIMAL(20, 10),
    best_ask DECIMAL(20, 10),
    spread DECIMAL(20, 10),
    last_trade_price DECIMAL(20, 10),
    mid_price DECIMAL(20, 10)
);

-- Convert to hypertable
SELECT create_hypertable('market_orderbooks', 'time',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE
);

-- Compression policy (compress after 1 day)
ALTER TABLE market_orderbooks SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'asset_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('market_orderbooks', INTERVAL '1 day');

-- Retention policy (drop after 7 days - cold data goes to ClickHouse)
SELECT add_retention_policy('market_orderbooks', INTERVAL '7 days');

-- Indexes for common queries
CREATE INDEX idx_orderbooks_asset_time ON market_orderbooks(asset_id, time DESC);
CREATE INDEX idx_orderbooks_market_time ON market_orderbooks(market_id, time DESC);

-- Activities table (trades, fills)
CREATE TABLE market_activities (
    time TIMESTAMPTZ NOT NULL,
    market_hash VARCHAR(66) NOT NULL,
    asset_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    price DECIMAL(20, 10),
    size DECIMAL(20, 10),
    side VARCHAR(10),
    maker VARCHAR(255),
    taker VARCHAR(255),
    trade_id VARCHAR(255)
);

SELECT create_hypertable('market_activities', 'time',
    chunk_time_interval => INTERVAL '1 day'
);

ALTER TABLE market_activities SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'asset_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('market_activities', INTERVAL '1 day');
SELECT add_retention_policy('market_activities', INTERVAL '30 days');

-- Continuous aggregates for real-time analytics
CREATE MATERIALIZED VIEW orderbook_hourly
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    asset_id,
    market_id,
    AVG(spread) AS avg_spread,
    MIN(spread) AS min_spread,
    MAX(spread) AS max_spread,
    AVG(mid_price) AS avg_mid_price,
    COUNT(*) AS update_count
FROM market_orderbooks
GROUP BY bucket, asset_id, market_id;

SELECT add_continuous_aggregate_policy('orderbook_hourly',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
```

### 5.4 ClickHouse Schema (Cold Storage)

```sql
-- Orderbook history (partitioned by month)
CREATE TABLE orderbook_history (
    time DateTime64(3),
    market_hash String,
    asset_id String,
    slug String,
    market_id UInt64,
    bids String,  -- JSON string
    asks String,
    best_bid Decimal64(10),
    best_ask Decimal64(10),
    spread Decimal64(10),
    last_trade_price Decimal64(10),
    mid_price Decimal64(10),
    
    -- Derived fields for analytics
    bid_depth Decimal64(10),
    ask_depth Decimal64(10),
    imbalance Decimal64(10)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(time)
ORDER BY (asset_id, time)
TTL time + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- Trade history
CREATE TABLE trade_history (
    time DateTime64(3),
    market_hash String,
    asset_id String,
    event_type String,
    price Decimal64(10),
    size Decimal64(10),
    side String,
    trade_id String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(time)
ORDER BY (asset_id, time)
TTL time + INTERVAL 365 DAY;

-- Hourly aggregates (materialized view)
CREATE MATERIALIZED VIEW orderbook_hourly_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (asset_id, bucket)
AS SELECT
    toStartOfHour(time) AS bucket,
    asset_id,
    market_id,
    avg(spread) AS avg_spread,
    min(spread) AS min_spread,
    max(spread) AS max_spread,
    avg(mid_price) AS avg_mid_price,
    count() AS update_count
FROM orderbook_history
GROUP BY bucket, asset_id, market_id;

-- Daily VWAP
CREATE MATERIALIZED VIEW daily_vwap_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (asset_id, day)
AS SELECT
    toDate(time) AS day,
    asset_id,
    sum(price * size) / sum(size) AS vwap,
    sum(size) AS total_volume,
    count() AS trade_count,
    min(price) AS low,
    max(price) AS high,
    argMin(price, time) AS open,
    argMax(price, time) AS close
FROM trade_history
WHERE event_type = 'last_trade'
GROUP BY day, asset_id;
```

---

## 6. Processing / Consumers

### 6.1 DB Writer Consumer

```go
// db_writer.go
package consumer

import (
    "context"
    "database/sql"
    "encoding/json"
    "sync"
    "time"

    "github.com/segmentio/kafka-go"
    "go.uber.org/zap"
)

type DBWriter struct {
    kafkaReader *kafka.Reader
    db          *sql.DB
    logger      *zap.Logger
    
    batchSize   int
    flushInterval time.Duration
    
    mu          sync.Mutex
    buffer      []OrderbookRecord
}

type OrderbookRecord struct {
    Time           time.Time
    MarketHash     string
    AssetID        string
    Slug           string
    Bids           json.RawMessage
    Asks           json.RawMessage
    BestBid        float64
    BestAsk        float64
    Spread         float64
    LastTradePrice float64
}

func NewDBWriter(brokers []string, topic, groupID string, db *sql.DB, logger *zap.Logger) *DBWriter {
    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:        brokers,
        Topic:          topic,
        GroupID:        groupID,
        MinBytes:       10e3,  // 10KB
        MaxBytes:       10e6,  // 10MB
        MaxWait:        500 * time.Millisecond,
        CommitInterval: time.Second,
        StartOffset:    kafka.LastOffset,
    })

    return &DBWriter{
        kafkaReader:   reader,
        db:            db,
        logger:        logger,
        batchSize:     1000,
        flushInterval: time.Second,
        buffer:        make([]OrderbookRecord, 0, 1000),
    }
}

func (w *DBWriter) Start(ctx context.Context) {
    // Start flush timer
    go w.flushRoutine(ctx)

    for {
        select {
        case <-ctx.Done():
            w.flush() // Final flush
            return
        default:
        }

        msg, err := w.kafkaReader.FetchMessage(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return
            }
            w.logger.Error("Failed to fetch message", zap.Error(err))
            continue
        }

        record, err := w.parseMessage(msg)
        if err != nil {
            w.logger.Debug("Failed to parse message", zap.Error(err))
            w.kafkaReader.CommitMessages(ctx, msg)
            continue
        }

        w.mu.Lock()
        w.buffer = append(w.buffer, record)
        needsFlush := len(w.buffer) >= w.batchSize
        w.mu.Unlock()

        if needsFlush {
            w.flush()
        }

        // Commit offset
        w.kafkaReader.CommitMessages(ctx, msg)
    }
}

func (w *DBWriter) parseMessage(msg kafka.Message) (OrderbookRecord, error) {
    var socketMsg SocketMessage
    if err := json.Unmarshal(msg.Value, &socketMsg); err != nil {
        return OrderbookRecord{}, err
    }

    record := OrderbookRecord{
        Time:       time.UnixMilli(socketMsg.Timestamp),
        MarketHash: socketMsg.Market,
        AssetID:    socketMsg.AssetID,
    }

    if socketMsg.Bids != nil {
        record.Bids, _ = json.Marshal(socketMsg.Bids)
        record.BestBid = extractBestBid(socketMsg.Bids)
    }
    if socketMsg.Asks != nil {
        record.Asks, _ = json.Marshal(socketMsg.Asks)
        record.BestAsk = extractBestAsk(socketMsg.Asks)
    }
    if record.BestBid > 0 && record.BestAsk > 0 {
        record.Spread = record.BestAsk - record.BestBid
    }
    if socketMsg.Price != "" {
        record.LastTradePrice, _ = strconv.ParseFloat(socketMsg.Price, 64)
    }

    return record, nil
}

func (w *DBWriter) flush() {
    w.mu.Lock()
    if len(w.buffer) == 0 {
        w.mu.Unlock()
        return
    }
    records := w.buffer
    w.buffer = make([]OrderbookRecord, 0, w.batchSize)
    w.mu.Unlock()

    // Batch insert using COPY protocol for best performance
    txn, err := w.db.Begin()
    if err != nil {
        w.logger.Error("Failed to begin transaction", zap.Error(err))
        return
    }

    stmt, err := txn.Prepare(`
        INSERT INTO market_orderbooks 
        (time, market_hash, asset_id, bids, asks, best_bid, best_ask, spread, last_trade_price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `)
    if err != nil {
        txn.Rollback()
        w.logger.Error("Failed to prepare statement", zap.Error(err))
        return
    }

    for _, record := range records {
        _, err := stmt.Exec(
            record.Time,
            record.MarketHash,
            record.AssetID,
            record.Bids,
            record.Asks,
            record.BestBid,
            record.BestAsk,
            record.Spread,
            record.LastTradePrice,
        )
        if err != nil {
            w.logger.Error("Failed to insert record", zap.Error(err))
        }
    }

    if err := txn.Commit(); err != nil {
        w.logger.Error("Failed to commit transaction", zap.Error(err))
        return
    }

    w.logger.Info("Flushed records to DB", zap.Int("count", len(records)))
}

func (w *DBWriter) flushRoutine(ctx context.Context) {
    ticker := time.NewTicker(w.flushInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            w.flush()
        }
    }
}
```

### 6.2 Aggregator Service

```go
// aggregator.go
package consumer

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/segmentio/kafka-go"
    "go.uber.org/zap"
)

type Aggregator struct {
    kafkaReader *kafka.Reader
    redis       *redis.Client
    logger      *zap.Logger
    
    // In-memory aggregation state
    vwapState   map[string]*VWAPState
}

type VWAPState struct {
    SumPriceVolume float64
    SumVolume      float64
    TradeCount     int64
    LastUpdate     time.Time
}

func (a *Aggregator) Start(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        msg, err := a.kafkaReader.FetchMessage(ctx)
        if err != nil {
            continue
        }

        var socketMsg SocketMessage
        if err := json.Unmarshal(msg.Value, &socketMsg); err != nil {
            a.kafkaReader.CommitMessages(ctx, msg)
            continue
        }

        // Process based on event type
        switch socketMsg.EventType {
        case "book":
            a.processOrderbook(ctx, socketMsg)
        case "last_trade":
            a.processTrade(ctx, socketMsg)
        }

        a.kafkaReader.CommitMessages(ctx, msg)
    }
}

func (a *Aggregator) processOrderbook(ctx context.Context, msg SocketMessage) {
    // Extract best bid/ask and calculate mid price
    bestBid := extractBestBid(msg.Bids)
    bestAsk := extractBestAsk(msg.Asks)
    
    if bestBid == 0 || bestAsk == 0 {
        return
    }

    midPrice := (bestBid + bestAsk) / 2
    spread := bestAsk - bestBid

    // Store latest state in Redis
    state := map[string]interface{}{
        "best_bid":   bestBid,
        "best_ask":   bestAsk,
        "mid_price":  midPrice,
        "spread":     spread,
        "updated_at": time.Now().Unix(),
    }

    stateJSON, _ := json.Marshal(state)
    a.redis.Set(ctx, 
        "orderbook_state:"+msg.AssetID, 
        stateJSON, 
        5*time.Minute,
    )

    // Check for spread alerts
    if spread > 0.05 { // 5% spread threshold
        a.publishAlert(ctx, "high_spread", msg.AssetID, spread)
    }
}

func (a *Aggregator) processTrade(ctx context.Context, msg SocketMessage) {
    price, _ := strconv.ParseFloat(msg.Price, 64)
    size, _ := strconv.ParseFloat(msg.Size, 64)

    if price == 0 || size == 0 {
        return
    }

    // Update VWAP
    state, exists := a.vwapState[msg.AssetID]
    if !exists {
        state = &VWAPState{}
        a.vwapState[msg.AssetID] = state
    }

    state.SumPriceVolume += price * size
    state.SumVolume += size
    state.TradeCount++
    state.LastUpdate = time.Now()

    vwap := state.SumPriceVolume / state.SumVolume

    // Store VWAP in Redis
    vwapData := map[string]interface{}{
        "vwap":        vwap,
        "volume":      state.SumVolume,
        "trade_count": state.TradeCount,
        "updated_at":  state.LastUpdate.Unix(),
    }

    vwapJSON, _ := json.Marshal(vwapData)
    a.redis.Set(ctx,
        "vwap:"+msg.AssetID,
        vwapJSON,
        24*time.Hour,
    )
}

func (a *Aggregator) publishAlert(ctx context.Context, alertType, assetID string, value float64) {
    alert := map[string]interface{}{
        "type":     alertType,
        "asset_id": assetID,
        "value":    value,
        "time":     time.Now().Unix(),
    }

    alertJSON, _ := json.Marshal(alert)
    a.redis.Publish(ctx, "alerts:orderbook", alertJSON)
}
```

---

## 7. Scaling & Resilience

### 7.1 Horizontal Scaling Plan

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       SCALING STRATEGY                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  WEBSOCKET HANDLERS                                                      │
│  ─────────────────────                                                   │
│  • Scale horizontally based on token count                              │
│  • Formula: ceil(total_tokens / 50) connections per pod                 │
│  • HPA: Scale on CPU (>70%) or custom metric (tokens per pod)          │
│                                                                          │
│  Current: 1000 tokens → 20 connections → 1 pod (4 CPU, 4GB)            │
│  Scale:   5000 tokens → 100 connections → 3 pods                        │
│  Scale:  10000 tokens → 200 connections → 5 pods                        │
│                                                                          │
│  KAFKA CLUSTER                                                           │
│  ─────────────                                                           │
│  • 3 brokers minimum for HA                                             │
│  • 12 partitions per topic (allows 12 parallel consumers)               │
│  • Add brokers for throughput (linear scaling)                          │
│                                                                          │
│  Current: 10K msg/s → 3 brokers                                         │
│  Scale:   50K msg/s → 5 brokers                                         │
│  Scale:  100K msg/s → 7 brokers                                         │
│                                                                          │
│  DB WRITERS                                                              │
│  ──────────                                                              │
│  • 1 consumer per partition (max 12)                                    │
│  • Scale by adding partitions (requires topic recreation)               │
│  • Batch size tuning for throughput vs latency                          │
│                                                                          │
│  TIMESCALEDB                                                             │
│  ───────────                                                             │
│  • Vertical scaling first (CPU, RAM, IOPS)                              │
│  • Multi-node for extreme scale (TimescaleDB Cloud)                     │
│  • Read replicas for analytics queries                                  │
│                                                                          │
│  Tier 1: 8 vCPU, 32GB RAM, 1TB SSD → 50K writes/s                      │
│  Tier 2: 16 vCPU, 64GB RAM, 2TB SSD → 100K writes/s                    │
│  Tier 3: Multi-node cluster → 500K+ writes/s                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Fault Tolerance

```go
// resilience.go
package common

import (
    "context"
    "time"

    "github.com/cenkalti/backoff/v4"
)

// RetryWithBackoff - Generic retry with exponential backoff
func RetryWithBackoff(ctx context.Context, operation func() error) error {
    b := backoff.NewExponentialBackOff()
    b.MaxElapsedTime = 5 * time.Minute
    b.MaxInterval = 30 * time.Second

    return backoff.Retry(func() error {
        select {
        case <-ctx.Done():
            return backoff.Permanent(ctx.Err())
        default:
            return operation()
        }
    }, backoff.WithContext(b, ctx))
}

// CircuitBreaker - Simple circuit breaker implementation
type CircuitBreaker struct {
    maxFailures   int
    resetTimeout  time.Duration
    failures      int
    lastFailure   time.Time
    state         string // closed, open, half-open
}

func (cb *CircuitBreaker) Execute(operation func() error) error {
    if cb.state == "open" {
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.state = "half-open"
        } else {
            return ErrCircuitOpen
        }
    }

    err := operation()
    if err != nil {
        cb.failures++
        cb.lastFailure = time.Now()
        
        if cb.failures >= cb.maxFailures {
            cb.state = "open"
        }
        return err
    }

    cb.failures = 0
    cb.state = "closed"
    return nil
}
```

### 7.3 Monitoring & Metrics

```go
// metrics.go
package monitoring

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // WebSocket metrics
    WebsocketConnections = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "polymarket_websocket_connections",
            Help: "Number of active websocket connections",
        },
        []string{"status"},
    )

    WebsocketMessagesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "polymarket_websocket_messages_total",
            Help: "Total websocket messages received",
        },
        []string{"event_type"},
    )

    WebsocketReconnects = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "polymarket_websocket_reconnects_total",
            Help: "Total websocket reconnection attempts",
        },
    )

    // Kafka metrics
    KafkaProducedMessages = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "polymarket_kafka_produced_total",
            Help: "Total messages produced to Kafka",
        },
        []string{"topic"},
    )

    KafkaProduceLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "polymarket_kafka_produce_latency_seconds",
            Help:    "Kafka produce latency",
            Buckets: prometheus.DefBuckets,
        },
        []string{"topic"},
    )

    // Database metrics
    DBWriteLatency = promauto.NewHistogram(
        prometheus.HistogramOpts{
            Name:    "polymarket_db_write_latency_seconds",
            Help:    "Database write latency",
            Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
        },
    )

    DBBatchSize = promauto.NewHistogram(
        prometheus.HistogramOpts{
            Name:    "polymarket_db_batch_size",
            Help:    "Size of database write batches",
            Buckets: []float64{10, 50, 100, 250, 500, 1000, 2000},
        },
    )

    // Discovery metrics
    ActiveTokens = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "polymarket_active_tokens",
            Help: "Number of actively monitored tokens",
        },
    )

    MarketsDiscovered = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "polymarket_markets_discovered_total",
            Help: "Total markets discovered",
        },
    )

    MarketsClosed = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "polymarket_markets_closed_total",
            Help: "Total markets closed",
        },
    )
)
```

---

## 8. Deployment & Operations

### 8.1 Kubernetes Manifests

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: polymarket-ingestion
  labels:
    app: polymarket-ingestion
spec:
  replicas: 2
  selector:
    matchLabels:
      app: polymarket-ingestion
  template:
    metadata:
      labels:
        app: polymarket-ingestion
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      containers:
      - name: ingestion
        image: gcr.io/PROJECT/polymarket-ingestion:latest
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        env:
        - name: KAFKA_BROKERS
          valueFrom:
            configMapKeyRef:
              name: polymarket-config
              key: kafka_brokers
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: polymarket-secrets
              key: redis_url
        - name: DB_URL
          valueFrom:
            secretKeyRef:
              name: polymarket-secrets
              key: db_url
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: metrics
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 10"]  # Graceful shutdown
---
# HPA for auto-scaling
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: polymarket-ingestion-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: polymarket-ingestion
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: polymarket_websocket_connections
      target:
        type: AverageValue
        averageValue: "100"  # Scale when avg connections > 100
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

### 8.2 Helm Values

```yaml
# values.yaml
replicaCount: 2

image:
  repository: gcr.io/PROJECT/polymarket-ingestion
  tag: latest
  pullPolicy: Always

resources:
  requests:
    cpu: "2"
    memory: "4Gi"
  limits:
    cpu: "4"
    memory: "8Gi"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

kafka:
  brokers: "kafka-0.kafka:9092,kafka-1.kafka:9092,kafka-2.kafka:9092"
  topics:
    orderbook: "orderbook-updates"
    activities: "market-activities"
    state: "market-state"

redis:
  host: redis-master
  port: 6379

database:
  host: timescaledb
  port: 5432
  name: polymarket
  maxConnections: 50

websocket:
  maxTokensPerSocket: 50
  pingIntervalMs: 10000
  reconnectMaxAttempts: 5

ingestion:
  batchSize: 1000
  flushIntervalMs: 1000

discovery:
  intervalMinutes: 15
  cleanupIntervalMinutes: 15

monitoring:
  enabled: true
  port: 9090
```

---

## 9. Runbook

### 9.1 Add New Markets

```bash
#!/bin/bash
# add-market.sh

# 1. Trigger manual discovery
curl -X POST http://polymarket-ingestion:8080/api/discovery/trigger

# 2. Add specific slug
curl -X POST http://polymarket-ingestion:8080/api/discovery/slug \
  -H "Content-Type: application/json" \
  -d '{"slug": "btc-updown-15m-1764612000"}'

# 3. Verify subscription
curl http://polymarket-ingestion:8080/api/status/tokens | jq
```

### 9.2 Handle Message Storm

```bash
#!/bin/bash
# handle-storm.sh

# 1. Check current metrics
kubectl top pods -l app=polymarket-ingestion

# 2. Scale up consumers quickly
kubectl scale deployment polymarket-ingestion --replicas=5

# 3. Increase batch size temporarily
kubectl set env deployment/polymarket-ingestion BATCH_SIZE=2000

# 4. Check Kafka lag
kafka-consumer-groups.sh --bootstrap-server kafka:9092 \
  --describe --group db-writer

# 5. If lag is too high, pause non-critical consumers
kubectl scale deployment polymarket-aggregator --replicas=0

# 6. Monitor until stable
watch -n 5 'kubectl exec kafka-0 -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --group db-writer'
```

### 9.3 Graceful Socket Shutdown

```go
// shutdown.go
package main

import (
    "context"
    "os"
    "os/signal"
    "syscall"
    "time"

    "go.uber.org/zap"
)

func main() {
    logger, _ := zap.NewProduction()
    
    // Initialize components
    socketManager := NewSocketManager(...)
    dbWriter := NewDBWriter(...)
    
    // Start services
    ctx, cancel := context.WithCancel(context.Background())
    
    go socketManager.Start(ctx)
    go dbWriter.Start(ctx)
    
    // Wait for shutdown signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    
    <-sigChan
    logger.Info("Shutdown signal received, initiating graceful shutdown...")
    
    // 1. Stop accepting new connections
    // 2. Close existing sockets gracefully
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()
    
    // Stop socket manager first (no new messages)
    socketManager.Shutdown()
    
    // Wait for buffer to drain
    time.Sleep(5 * time.Second)
    
    // Cancel main context
    cancel()
    
    // Flush remaining data
    dbWriter.Flush()
    
    logger.Info("Graceful shutdown complete")
}
```

### 9.4 Emergency Procedures

```bash
# emergency-stop.sh - Stop all data ingestion immediately

#!/bin/bash
set -e

echo "🚨 EMERGENCY STOP INITIATED"

# 1. Scale down ingestion pods to 0
kubectl scale deployment polymarket-ingestion --replicas=0

# 2. Pause Kafka consumers
kubectl scale deployment polymarket-db-writer --replicas=0
kubectl scale deployment polymarket-aggregator --replicas=0

# 3. Clear Redis active tokens (optional - only if needed)
# redis-cli -h redis-master FLUSHDB

echo "✅ All ingestion stopped. Check status:"
kubectl get pods -l app.kubernetes.io/part-of=polymarket

# To resume:
# kubectl scale deployment polymarket-ingestion --replicas=2
# kubectl scale deployment polymarket-db-writer --replicas=2
# kubectl scale deployment polymarket-aggregator --replicas=1
```

---

## 10. Cost Estimation

### 10.1 GCP/AWS Monthly Cost (1000 tokens)

| Component | Spec | Monthly Cost |
|-----------|------|--------------|
| **Ingestion Pods** | 2x n2-standard-4 | ~$200 |
| **Kafka Cluster** | 3x n2-standard-2 | ~$150 |
| **TimescaleDB** | 1x n2-highmem-4 + 500GB SSD | ~$300 |
| **ClickHouse** | 1x n2-standard-4 + 1TB HDD | ~$200 |
| **Redis** | 1x n2-standard-2 (6GB) | ~$80 |
| **Networking** | Egress ~500GB | ~$50 |
| **Total** | | **~$980/month** |

### 10.2 Optimization Tips

1. **Use Spot/Preemptible instances** for ingestion pods (-70% cost)
2. **Enable TimescaleDB compression** aggressively (save 80% storage)
3. **Use Kafka tiered storage** (move old data to S3)
4. **Right-size Redis** (6GB is usually enough for cache)
5. **Consider managed services** (CloudSQL, Confluent Cloud) for reduced ops overhead

---

## 11. Summary & Next Steps

### Recommended Technology Stack

| Layer | Technology | Reason |
|-------|------------|--------|
| **WebSocket Handler** | Go | High performance, low memory, excellent concurrency |
| **Message Queue** | Kafka | Durability, scalability, replay capability |
| **Hot Storage** | TimescaleDB | PostgreSQL compatibility, time-series optimized |
| **Cold Storage** | ClickHouse | Excellent compression, fast analytics |
| **Cache** | Redis | Real-time state, pub/sub for alerts |
| **Container** | Kubernetes | Auto-scaling, self-healing |

### Implementation Priority

1. **Phase 1 (Week 1-2)**: Go WebSocket handlers + Kafka setup
2. **Phase 2 (Week 3)**: DB Writer consumers + TimescaleDB schema
3. **Phase 3 (Week 4)**: Aggregator service + Redis cache
4. **Phase 4 (Week 5)**: ClickHouse migration + archival
5. **Phase 5 (Week 6)**: Monitoring, alerting, runbooks

### Key Metrics to Monitor

- WebSocket connection count & reconnect rate
- Kafka consumer lag (< 1000 messages)
- DB write latency (p99 < 100ms)
- Active token count
- Message throughput (msgs/sec)
- Error rate (< 0.1%)

