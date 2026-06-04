-- Starter-HBAR drip log. One row per recipient address (PK = one drip per wallet,
-- ever). Used both as the idempotency/dedupe lock and the budget counter
-- (max drips = GAS_DRIP_BUDGET_HBAR / GAS_DRIP_AMOUNT_HBAR; count rows in
-- ('sent','pending')). Service-role only. The drip itself (viem native HBAR
-- transfer over the Hedera RPC) is gated + sent in frontend/src/lib/gas-drip.ts;
-- a native value transfer to a fresh 0x auto-creates the recipient's Hedera
-- account, which is how a MetaMask wallet gets its 0.0.x.
create table if not exists public.gas_drips (
  address     text primary key,             -- lowercased 0x recipient
  account_id  text,                         -- resolved 0.0.x (may be null until created)
  amount_hbar numeric not null default 0,   -- HBAR sent (0 when skipped)
  status      text not null,                -- pending | sent | skipped_funded | failed
  tx_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.gas_drips enable row level security;
create index if not exists gas_drips_status_idx on public.gas_drips (status);