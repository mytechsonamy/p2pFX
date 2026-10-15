# Reconciliation

Every day the platform checks its own records against core banking and the LPs and reports where they disagree. It
changes nothing: a break is resolved with the existing settlement, deal and hedge operations, and the next run shows
it gone.

The check exists because a platform that keeps its own copy of trades next to the bank's ledger drifts from it
sooner or later: a timeout booked on one side only, a manual posting, a retry under a new key while the old one stayed
booked. Bank IT audits of FX platforms find exactly this (trades in the platform's database that core banking does
not have, and the reverse), so the platform finds it first.

## What is compared

For a window `[from, to)`, the platform records created in it, plus older ones (up to 31 days) that changed in it
or are still open: a settlement in flight at the previous cutoff is checked once it has an outcome, and reported as
an open item while it has none.

| Platform record | Compared with | Break when |
|---|---|---|
| Settlement leg `SETTLED` | Core banking posting with the leg's idempotency key | Missing, reversed, other txnRef, or leg, customer, currency, quantity, customer amount, commission or tax differ |
| Settlement leg `REVERSED` | Same | Not in core banking, or booked and not reversed |
| Earlier retry rounds of a leg (`fill:<id>:<leg>:r<n>` below the current round) | Postings under those keys | Booked and not reversed: `DUPLICATE_POSTING` |
| Settlement leg `FAILED_NEEDS_REVIEW` | Same | Booked and not reversed |
| Bank deal `SETTLED` | Posting with key `deal:<id>` | As for a settled leg (commission 0) |
| Bank deal `REJECTED` or `FAILED_NEEDS_REVIEW` | Same | Booked |
| Hedge clip `DONE` | LP execution with the clip's `lp_ref` | Missing at the LP, or side, pair, quantity, trade reference or rate differ (for a synthetic two-leg hedge only the trade references and the rate are the LPs' own) |
| Hedge clip `REJECTED` | Same | The LP shows an execution |

Core banking → platform, when the adapter can list postings (`listFxTransactions`):

| Core banking posting (posted in the window) | Break when |
|---|---|
| Key the platform never issued, or a fill leg or deal the platform does not have | `UNKNOWN_IN_PLATFORM` |
| Key of an earlier retry round of a fill leg, not reversed | `DUPLICATE_POSTING` (the customer was booked twice) |

Records still in flight (`PENDING`, `UNKNOWN_OUTCOME`, `REVERSAL_PENDING`, open hedge clips) are not breaks. Once
they are older than `openItemAfterMinutes` (counted from creation: recovery touches a stuck record every minute)
they are listed as open items. A lookup that fails (core banking or an LP not answering) is an open item too, never a
break.

LP lookups are lookup-only: a synthetic two-leg hedge whose second leg cannot be found is reported as an open item,
never completed from the reconciliation (the hedge recovery does that). A reconciliation never trades and never
posts.

A posting made after the window for a record created in it (a retry the next morning) is looked up by its key, so
window edges do not produce false breaks.

## Without a listing

`listFxTransactions` is optional in `CoreBankingAdapter`. A bank whose core cannot list the channel's postings
still gets the platform → core check by key (`findFxTransaction`), without amounts. The run records
`coreListing: false`, and postings the platform does not know cannot be found. Whether a posting was reversed is not
known either: a failed, rejected or reversed record that core banking has is an open item
(`REVERSAL_NOT_VERIFIABLE`), not a break. Banks should provide the listing: it
is the half of the check that catches what the platform never saw.

## Running it

- **Daily.** `reconciliation.dailyAt` (default 23:30, local time in `tradingHours.timezone`) on the matching
  instance's scheduler, covering the `lookbackHours` before it (default 24). It runs in the background, so a long
  run does not hold up the scheduler's other work. The previous day's run is caught up if the service was down at
  the time (only the previous day: after a longer outage, run the missed days from operations). A failed run is
  tried again after 30 minutes, three times at most, then logged as an error.
- **On demand.** `POST /ops/reconciliation/runs { from?, to? }` (editor role; default the last 24 hours, at most 31
  days). One run at a time; a second one is refused with `409 RECONCILIATION_RUNNING`.
- **Results.** `GET /ops/reconciliation/runs`, `GET /ops/reconciliation/runs/:id` (with the items). Status
  `CLEAN`, `OPEN_ITEMS`, `BREAKS` or `FAILED`. The summary has counts per kind and, with a listing, base currency
  totals bought and sold on each side. `/ready` shows the last run and its counts (informational: breaks do not make
  the instance unready). Each run is in the audit log; a run with breaks is logged as an error.

## Configuration

```jsonc
"reconciliation": { "enabled": true, "dailyAt": "23:30", "lookbackHours": 24, "openItemAfterMinutes": 30 }
```

## Limits

- Hedges are looked up one by one at their LP. That is fine for retail volumes; a bank with many clips a day should
  give the LP adapter a listing as well.
- Positions are not reconciled with the bank's treasury system; they follow from the records checked here.
- There is no back office screen yet; the ops API returns everything a screen needs.
