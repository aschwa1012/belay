'use strict';
// usage-price.cjs — the price table and the per-message dollar arithmetic shared by the transcript reader (cli) and the
// estimate a killed worker's row carries (core). Cost here is an ESTIMATE at API rates from a message's own usage, never a
// figure Claude Code reported; a subscription user pays nothing per token.

// Dollars per million tokens, keyed by the exact message.model. Source: Anthropic first-party rates in Claude
// Code's bundled claude-api skill model table (cached 2026-10-06). A model with `tiers` is priced per message by
// its prompt size (input + cache_creation + cache_read): the first tier whose `up_to` is not exceeded.
const R = (input, output, cache_read, cache_write_5m, cache_write_1h) => ({ input, output, cache_read, cache_write_5m, cache_write_1h });
const PRICES = Object.freeze({
  'claude-opus-5-5': R(4, 20, 0.20, 5, 8),
  'claude-sonnet-5-5': R(2, 10, 0.20, 2.50, 4),
  'claude-fable-5-1': R(10, 50, 0.25, 12.50, 20),
  'claude-haiku-5-5': { tiers: [{ up_to: 100000, ...R(0.10, 0.50, 0.01, 0.125, 0.20) }, { up_to: Infinity, ...R(0.50, 2.50, 0.05, 0.625, 1.00) }] },
});

function priceOf(prices, model, u) {
  const p = prices[model];
  if (!p) return null;
  if (!p.tiers) return p;
  const prompt = u.input + u.cache_read + u.cache_creation;
  return p.tiers.find((t) => prompt <= t.up_to) || null;
}

// Dollars of one message, and whether its cache writes had to be priced all at the 5m rate.
function messageUsd(prices, model, u) {
  const p = priceOf(prices, model, u);
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cc5m * p.cache_write_5m + u.cc1h * p.cache_write_1h) / 1e6;
}

module.exports = { PRICES, priceOf, messageUsd };
