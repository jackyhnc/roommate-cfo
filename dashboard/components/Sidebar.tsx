'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ACTIVITY, HOUSE, ROOMMATES } from '@/lib/demo';

const LINKS = [
  { href: '/', label: 'Payments' },
  { href: '/roommates', label: 'Roommates' },
];

export default function Sidebar() {
  const path = usePathname();
  const votes = ACTIVITY.filter((a) => a.status === 'pending' || a.status === 'held').length;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">R</span>
        {HOUSE.name}
      </div>
      <nav>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path === l.href ? 'active' : ''}>
            {l.label}
            {l.href === '/' && votes > 0 && <span className="badge">{votes}</span>}
          </Link>
        ))}
      </nav>
      <div className="user">
        <span className="user-avatar">{ROOMMATES[0].name[0]}</span>
        <div>
          <div className="user-name">{ROOMMATES[0].name}</div>
          <div className="muted small">Roommate · signer</div>
        </div>
      </div>
    </aside>
  );
}
