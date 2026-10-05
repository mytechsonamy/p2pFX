-- Fixes from the re-audit of c0e89a0 (R01–R08).

-- R02: a reversal is recorded as an intent before it is sent. REVERSAL_PENDING means the leg may or may not
-- be reversed in core banking yet; it is retried with the same reversal key until core banking confirms it.
alter table settlements drop constraint settlements_status_check;
alter table settlements add constraint settlements_status_check
  check (status in ('PENDING', 'SETTLED', 'FAILED_NEEDS_REVIEW', 'REVERSED', 'UNKNOWN_OUTCOME', 'REVERSAL_PENDING'));

-- R05: a hold whose id never came back (lost response) is cleaned up by its reference.
alter table hold_tasks alter column hold_id drop not null;
alter table hold_tasks add column ref text;
alter table hold_tasks drop constraint hold_tasks_action_check;
alter table hold_tasks add constraint hold_tasks_action_check check (action in ('RELEASE', 'ADJUST', 'RELEASE_BY_REF'));
alter table hold_tasks add constraint hold_tasks_target_check check ((action = 'RELEASE_BY_REF') = (ref is not null and hold_id is null));

-- R03: a clip the LP has not shown yet stays UNKNOWN; only an operator who checked with the LP rejects it.
alter table hedges add column resolved_by text;
alter table hedges add column resolution_note text;
