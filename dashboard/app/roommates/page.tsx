import { HOUSE, ROOMMATES } from '@/lib/demo';
import { money } from '@/lib/format';

const COLORS = ['#5b8def', '#9a6dd7', '#e0a44a'];

export default function RoommatesPage() {
  const total = ROOMMATES.reduce((s, r) => s + r.deposited, 0);
  const expected = HOUSE.monthlyContribution * ROOMMATES.length;

  return (
    <>
      <h1>Roommates</h1>

      <div className="card">
        <div className="label">Total in the pool</div>
        <div className="big">{money(total)}</div>
        <div className="muted small">of {money(expected)} expected this month</div>
        <div className="stack">
          {ROOMMATES.map((r, i) => (
            <span key={r.name} style={{ width: `${(r.deposited / expected) * 100}%`, background: COLORS[i] }} />
          ))}
        </div>
        <div className="legend">
          {ROOMMATES.map((r, i) => (
            <span key={r.name}>
              <i style={{ background: COLORS[i] }} />
              {r.name}
            </span>
          ))}
        </div>
      </div>

      <section>
      <h2>Pitched in</h2>
      {ROOMMATES.map((r, i) => {
        const short = HOUSE.monthlyContribution - r.deposited;
        return (
          <div key={r.name} className="row">
            <span className="avatar" style={{ background: COLORS[i] }}>{r.name[0]}</span>
            <div className="grow">
              <div>{r.name}</div>
              <div className="progress">
                <span style={{ width: `${(r.deposited / HOUSE.monthlyContribution) * 100}%`, background: COLORS[i] }} />
              </div>
            </div>
            {short > 0 ? <span className="tag orange">Short {money(short)}</span> : <span className="tag green">Paid up</span>}
            <span className="amount">{money(r.deposited)}</span>
          </div>
        );
      })}
      </section>
    </>
  );
}
