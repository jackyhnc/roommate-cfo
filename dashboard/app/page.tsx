import { ACTIVITY, type Activity } from '@/lib/demo';
import { date, money } from '@/lib/format';

const payments = ACTIVITY.filter((a) => a.kind !== 'deposit');

function Status({ a }: { a: Activity }) {
  if (a.status === 'held') return <span className="tag red">Held · {a.approvals?.length ?? 0}/{a.needed} votes</span>;
  if (a.status === 'pending') return <span className="tag orange">Needs vote · {a.approvals?.length ?? 0}/{a.needed}</span>;
  return <span className="tag green">Paid</span>;
}

export default function Payments() {
  const paid = payments.filter((a) => a.status === 'paid' && a.kind !== 'topup');
  const waiting = payments.filter((a) => a.status !== 'paid');
  const sum = (xs: Activity[]) => xs.reduce((s, a) => s + a.amount, 0);

  const days = new Map<string, Activity[]>();
  payments.forEach((a) => days.set(date(a.at), [...(days.get(date(a.at)) ?? []), a]));

  return (
    <>
      <h1>Payments</h1>

      <div className="cards">
        <div className="card">
          <div className="label">Paid</div>
          <div className="big">{money(sum(paid))}</div>
          <div className="muted small">{paid.length} payments</div>
        </div>
        <div className="card">
          <div className="label">Waiting on a vote</div>
          <div className="big">{money(sum(waiting))}</div>
          <div className="muted small">{waiting.length} payments</div>
        </div>
      </div>

      {[...days].map(([day, items]) => (
        <section key={day}>
          <h2>{day}</h2>
          {items.map((a) => (
            <div key={a.id} className="row">
              <span className={`icon ${a.status}`}>{a.kind === 'topup' ? '↻' : a.payee[0]}</span>
              <div className="grow">
                <div>{a.kind === 'topup' ? 'Allowance refill' : a.payee}</div>
                <div className="muted small">
                  {a.status === 'held' ? a.reason : a.kind === 'topup' ? 'Vault → Allowance, not counted as spending' : `${a.title} · from ${a.from}`}
                </div>
              </div>
              <Status a={a} />
              <span className="amount">{money(a.amount)}</span>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
