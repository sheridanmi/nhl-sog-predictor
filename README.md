# 🏒 SOG Edge Finder — NHL Shots on Goal Prediction Model

Scans **every NHL player** in tonight's games, runs 10,000 Monte Carlo simulations per player, and surfaces betting edges on SOG props.

## Quick Start

```bash
# 1. Install
npm install

# 2. Make sure .env has your Odds API key
# ODDS_API_KEY=your_key_here

# 3. Fetch live data (run daily before games)
npm run fetch

# 4. Open dashboard
npm run dev
```

## How It Works

**Data Pipeline** pulls from NHL API (free) + The Odds API (free tier), then the **Prediction Model** calculates projections using weighted factors (recent trends, opponent defense, TOI, PP time, etc.), runs **10,000 Monte Carlo simulations**, and compares model probabilities to sportsbook lines to find **edges**.

## Model Weights (Tunable)

Edit `MODEL_WEIGHTS` in `scripts/fetch-data.js`:

| Factor | Weight | Description |
|--------|--------|-------------|
| last5AvgSOG | 25% | Recent 5-game trend (hot/cold streaks) |
| seasonAvgSOG | 20% | Full season baseline |
| last10AvgSOG | 15% | Medium-term trend |
| oppShotsAgainst | 10% | Opponent defensive weakness |
| toiTrend | 8% | Ice time trending up/down |
| ppTimeFactor | 7% | Power play deployment |
| homeAwayAdj | 5% | Home vs away shooting splits |
| oppGoalieSVPct | 4% | Opposing goalie quality |
| backToBack | 3% | Fatigue penalty for B2B games |
| vegasTotal | 3% | Game pace proxy (O/U total) |

## API Usage (Free Tier)

- **NHL API**: Free, no key, no limits
- **Odds API**: 500 req/month free — daily usage ~10-15 req
