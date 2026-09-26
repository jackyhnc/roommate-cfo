// Demo data for the dashboard. Mirrors the backend's State (src/state.ts) and the
// README demo script: 3 roommates, 2-of-3 vault, agent allowance, auto-pay up to $100.

export type Roommate = { name: string; deposited: number; charged: number; note?: string };

export type Status = 'paid' | 'pending' | 'held' | 'received';

export type Activity = {
  id: string;
  at: string; // ISO timestamp
  kind: 'bill' | 'purchase' | 'topup' | 'deposit';
  category: 'Electric' | 'Internet' | 'Household' | 'Deposit' | 'Transfer' | 'Unknown';
  status: Status;
  title: string;
  payee: string;
  from: 'Vault' | 'Allowance' | string;
  amount: number;
  rule?: string;
  shares?: Record<string, number>;
  memo?: string;
  hash?: string;
  signers?: string[];
  approvals?: string[];
  needed?: number;
  proposedBy?: string;
  reason?: string;
};

export const HOUSE = {
  name: '412 Pine St',
  month: 'September 2026',
  monthlyContribution: 300,
  approvalLimit: 100,
  approvalsNeeded: 2,
  allowanceTopup: 150,
};

export const ACCOUNTS = {
  vault: { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', balance: 521 },
  allowance: { address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', balance: 90 },
};

export const ROOMMATES: Roommate[] = [
  { name: 'Calvin', deposited: 300, charged: 77.7 },
  { name: 'Eford', deposited: 300, charged: 96.1, note: 'Space heater' },
  { name: 'Ryan', deposited: 255, charged: 70.2, note: 'Away 10 days' },
];

export const RULES = [
  'Internet is split by days each person was home this month.',
  'Electricity is split equally, except whoever runs the space heater pays 40%.',
  'Anything else (water, shared purchases) is split equally.',
  'Bills up to $100 from known billers are paid automatically from the allowance.',
  'Anything over $100, every purchase, and any unknown payee needs 2 of 3 approvals.',
];

export const ACTIVITY: Activity[] = [
  {
    id: 'a8', at: '2026-09-26T11:30:00', kind: 'bill', category: 'Unknown', status: 'held',
    title: 'Final notice', payee: 'Unverified Payee', from: 'Vault', amount: 900,
    reason: 'Payee not on the allowlist, 4.9× the typical electric bill, over the allowance.',
    rule: 'Unknown payee: always needs a vote', approvals: [], needed: 2, proposedBy: 'CFO agent',
    shares: { Calvin: 300, Eford: 300, Ryan: 300 },
  },
  {
    id: 'a7', at: '2026-09-26T10:05:00', kind: 'purchase', category: 'Household', status: 'pending',
    title: 'Vacuum (Amazon)', payee: 'Store', from: 'Vault', amount: 90,
    rule: 'Shared purchase: split equally', approvals: ['Calvin'], needed: 2, proposedBy: 'Eford',
    shares: { Calvin: 30, Eford: 30, Ryan: 30 }, memo: 'Vacuum: Calvin 30, Eford 30, Ryan 30',
  },
  {
    id: 'a6', at: '2026-09-25T20:15:00', kind: 'bill', category: 'Electric', status: 'paid',
    title: 'Electric, September', payee: 'Bay Power & Light', from: 'Vault', amount: 184,
    rule: 'Electricity: equal, space heater pays 40%', signers: ['Calvin', 'Eford'], needed: 2,
    shares: { Calvin: 55.2, Eford: 73.6, Ryan: 55.2 },
    memo: 'Bay Power Sep: Calvin 55.20, Eford 73.60 (heater), Ryan 55.20',
    hash: '7C2E5B918D04F3A6E1C9B7D2A5F8E0314B6D9C2E7A0F5B8D1E4C7A2F9B3D6E08',
  },
  {
    id: 'a5', at: '2026-09-24T18:42:00', kind: 'bill', category: 'Internet', status: 'paid',
    title: 'Internet, September', payee: 'Metro Fiber', from: 'Allowance', amount: 60,
    rule: 'Internet: split by days home (Ryan away 10 of 30)', signers: ['CFO agent'],
    shares: { Calvin: 22.5, Eford: 22.5, Ryan: 15 },
    memo: 'Metro Fiber Sep: Calvin 22.50, Eford 22.50, Ryan 15.00',
    hash: 'B19E4C2A7F05D8E3C6A1B9F2D4E7C0A3F6B8D1E5C9A2F7B0D3E6C8A1F4B7D2E9',
  },
  {
    id: 'a4', at: '2026-09-03T14:20:00', kind: 'deposit', category: 'Deposit', status: 'received',
    title: 'Monthly contribution', payee: 'Vault', from: 'Ryan', amount: 255,
    memo: 'Ryan Sep contribution (short $45)',
    hash: 'C4D7A1E8F2B5C9D3E6A0F4B7C1D8E2A5F9B3C6D0E4A7F1B8C2D5E9A3F6B0C7D1',
  },
  {
    id: 'a3', at: '2026-09-01T09:20:00', kind: 'topup', category: 'Transfer', status: 'paid',
    title: 'Allowance refill', payee: 'Allowance', from: 'Vault', amount: 150,
    rule: 'Allowance refill: needs 2 of 3', signers: ['Calvin', 'Eford'], needed: 2,
    memo: 'Allowance refill Sep',
    hash: 'A41F09C2D7B35E8816F0C4A9E2B7D3106C8E5F2A9B1D4E7C03F6A8B2D5E9C1F4',
  },
  {
    id: 'a2', at: '2026-09-01T09:05:00', kind: 'deposit', category: 'Deposit', status: 'received',
    title: 'Monthly contribution', payee: 'Vault', from: 'Eford', amount: 300,
    memo: 'Eford Sep contribution',
    hash: 'E8A2C5F9B3D6A0E4C7F1B8D2A5E9C3F6B0D4A7E1C8F2B5D9A3E6C0F4B7D1A8E2',
  },
  {
    id: 'a1', at: '2026-09-01T09:02:00', kind: 'deposit', category: 'Deposit', status: 'received',
    title: 'Monthly contribution', payee: 'Vault', from: 'Calvin', amount: 300,
    memo: 'Calvin Sep contribution',
    hash: 'F3B6D9A2E5C8F1B4D7A0E3C6F9B2D5A8E1C4F7B0D3A6E9C2F5B8D1A4E7C0F3B6',
  },
];

export const KNOWN_BILLERS = ['Metro Fiber', 'Bay Power & Light'];
