-- Support for the injuries sync job: players need the same external-id
-- uniqueness teams/competitions got in 0002 (players.external_ref already
-- existed since 0001, just without a uniqueness constraint), and injuries
-- needs one to make repeated syncs idempotent — the initial schema didn't
-- anticipate ingesting them.
--
-- injuries is modeled as "current status per player," not a history of
-- every past report: a unique constraint on player_id alone is enough,
-- and syncInjuries.ts upserts against it. A player who is both, say,
-- on loan and has separate injury histories at two clubs in the same
-- window is a real but rare edge case this schema doesn't distinguish —
-- acceptable for now, tracked in Task.md rather than modeled here.

create unique index if not exists uq_players_external_api_football
  on players ((external_ref->>'api_football'))
  where external_ref ? 'api_football';

create unique index if not exists uq_injuries_player
  on injuries (player_id);
