# FX & Fund Consolidation Engine

Multi-currency FX rate resolution and NAV consolidation for a fund administration platform. I built and debugged these components as a backend intern at an investment firm. Extracted from the private codebase and stubbed to run standalone, shared with the firm's permission.

## Problem

A fund holds portfolio companies in different currencies through layers of holding entities (Fund -> SPV -> PortCo, modeled as a DAG). Computing the fund's NAV requires an exchange rate for every currency pair involved (including pairs no vendor quotes directly), converting values up the ownership tree with correct ownership weighting and debt allocation, and catching the failure modes that silently corrupt the result: stale rates, mismatched value dates, precision loss.

## Components

### src/fxRateResolver.ts

Rate resolution in order: direct stored quote, stored inverse quote, API backfill, then triangulation through USD (`EUR->JPY = (EUR->USD) x (USD->JPY)`).

Two production bugs I worked on live here:

- **Inversion precision.** Computing `1/rate` on an already-rounded stored rate compounds rounding error if the result gets inverted again downstream. The resolver uses the vendor-stored inverse rate instead of inverting locally.
- **Leg date mismatches in triangulation.** If EUR->USD was last quoted Friday and USD->JPY on Monday, their product is a rate that never existed. Mismatches are measured and surfaced as warnings, and `FX_STRICT_TRIANGULATION_DATE_MATCH=true` makes them fatal.

Also handles rate staleness tracking, batch pre-resolution for the waterfall, and storage abstraction via a `RateStore` interface (in-memory implementation included; production uses Postgres with soft-update history).

### src/currencyAPI.ts

CurrencyLayer integration. One `USD -> all` request per date, with all NxN cross rates computed locally to minimize quota usage. Concurrent callers for the same currencies+date share a single in-flight promise, successful historical responses are cached for the process lifetime, failures are cached briefly so upstream retry loops don't hammer the API, and 429s get exponential backoff.

Set `CURRENCY_API_KEY` in `.env` for live fetches. The demo runs offline without it.

### src/waterfall.ts

The consolidation math, as a pure function over pre-loaded inputs (no I/O; the production data loader is omitted). Rolls equity from portcos up through SPVs to the fund root: FX conversion at each edge, ownership-percentage weighting, proportional allocation of SPV-level debt across children, and valuation adjustments. Handles unreachable-entity pruning, exited positions (history kept, zero contribution), and validates ownership percentages and FX rates with structured warnings instead of failing silently.

### src/validation.ts

From the platform's document ingestion pipeline. Financial data extracted from documents by an LLM gets verified before it is persisted: each extracted field becomes an embedding search query (with a synonym map so `maintainable_ebitda` also matches "Adjusted EBITDA Normalized Pro-Forma"), the closest source chunks are retrieved, and a second pass classifies the value as explicitly supported, implicitly supported, calculated, or unsupported. Unsupported values get flagged as hallucinations.

## Demo

```bash
npm install
npx tsx examples/demo.ts
```

Seeds mock rates, resolves a triangulated EUR->JPY and a stored-inverse SGD->USD, then consolidates a mock USD fund holding a EUR SPV with EUR and JPY portfolio companies.

## Scope and role

I helped build the FX resolver and the waterfall, and fixed production issues in both (including the two described above). validation.ts is included as representative work from the same internship. Persistence and application layers are not included.
