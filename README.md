# Roommate CFO

> Your house gets a CFO, so none of your roommates has to be the bank.

An AI agent (Grok) that lives in the house iMessage group chat, holds the shared pool in RLUSD on the XRP Ledger, splits bills by house rules, and pays them. Small bills auto-pay from the agent's allowance. Anything bigger, and every purchase, needs 2 roommates to approve, enforced on-ledger by a 2-of-3 SignerList on the vault.

## How the money is set up (XRPL testnet)

| Account | Who controls it | Used for |
|---|---|---|
| **Vault** | Nobody alone: master key disabled, 2-of-3 roommate multisig | Holds the pool. Big bills, purchases, allowance refills |
| **Allowance** | The agent | Auto-pays bills ≤ $100. The most the agent can ever spend on its own is what's in here |
| Roommates ×3 | Each roommate (demo: the agent holds keys and signs when they say "yes") | Deposits into the vault, co-signing |
| Metro Fiber, Bay Power & Light, Store | Hardcoded payees | Receive payments |

Every payment carries a memo with the split, so the explorer link shows who owed what.

## Run it

```bash
npm install
cp .env.example .env        # add XAI_API_KEY
npm run setup               # ~1 min: creates accounts, deposits, multisig vault
npm run cli                 # rehearse in the terminal
npm start                   # live in iMessage
```

`npm run setup -- --fresh` resets everything with new accounts. Do this before each demo.

### iMessage (Photon imessage-kit)

1. On the Mac that will run the agent, sign in to Messages with the CFO's Apple ID (e.g. a fresh `roommatecfo@icloud.com`).
2. Add that Apple ID to the house group chat from anyone's phone.
3. Give your terminal **Full Disk Access** (System Settings → Privacy & Security).
4. Run `npm start` once. It lists group chats, so copy the name into `GROUP_CHAT_NAME` in `.env`.
5. Put each roommate's phone number or email in `CALVIN_HANDLE`, `EFORD_HANDLE`, `RYAN_HANDLE`. If you skip this, the first people to talk get the roommate names in order.

### Rehearsing in the terminal

```
calvin: /photo demo/bills/metro-fiber.png
eford: /photo demo/bills/bay-power.png
calvin: yes
eford: 👍
eford: can we get a vacuum? $90 on amazon
```

`npm run make-bills` regenerates the demo bill images in `demo/bills/`.

## Shopping agent (Grok in a real browser)

When roommates approve a purchase ("can we get a vacuum, like $90"), Grok goes and buys it: Stagehand's autonomous agent drives a visible Chrome on this Mac, searches the store (Amazon by default, or whatever site they named), compares options, stays under the approved budget, and checks out with the saved payment method. It posts the product, total, order number, and a screenshot to the group, then the vault settles the real total to the house card via 2-of-3 multisig on the XRPL.

Setup, once:

```bash
npm run browser   # opens Chrome with the agent's own profile (.chrome-profile)
```

Sign in to Amazon there (with a saved card + address), then close that window. The agent reuses that profile.

- `CHECKOUT=place` (default) places real orders on that account. `CHECKOUT=stop` goes to the final review screen and stops, for rehearsals.
- Guardrails given to the agent: approved amount is a hard budget, quantity 1, no subscriptions or Prime upsells, never enter new card numbers or passwords, stop on login or CAPTCHA.
- Close the `npm run browser` window before `npm start`: Chrome can't open the same profile twice.

## Demo script

**Setup:** 3 roommates, 300 RLUSD/month each. Ryan only put in $255.

1. **Small bill, auto-paid.** Drop `metro-fiber.png`. The agent reads $60, splits by days home (Ryan was away 10 days), and pays from the allowance. Tap the link and it shows one signer.
2. **Big bill, needs approval.** Drop `bay-power.png`. $184, Eford pays 40% (space heater). Over $100, so it asks for approval. Calvin says "yes" and Eford 👍s. The agent co-signs from the vault. Tap the link: **Signers: Calvin, Eford**.
3. **Purchase.** "can we get a vacuum? $90 on amazon". Purchases always go to a vote. Two approvals, paid.
4. **Chasing a late payer.** "@cfo who's behind?" The agent nudges Ryan for $45. Ryan says "send my share" and a real deposit lands in the vault.

Off-script things that work: several approvals open at once, "nvm" to cancel, 👎 or "no" to reject, duplicate approvals, questions like "how much have we spent on power?", and small bills when the allowance is empty (they go to a vote instead).

## "Why crypto?"

A shared account that no single roommate controls, with spending rules and 2-of-N approval enforced by the ledger itself, is something four people renting together can't get from a normal bank. Every payment is publicly auditable.

## Built with

- [Photon imessage-kit](https://github.com/photon-hq/imessage-kit) for iMessage
- Grok (`grok-4.7`) via the xAI API for bill reading and intent, with tool calls
- `xrpl.js` for payments, SignerList multisig and memos

Without an `XAI_API_KEY` (or if the API call fails), the agent uses a hardcoded fallback: photos are read as the two demo bills in order, and text is matched with simple rules.

## Future work (pitch, not built)

Off-ramping RLUSD to pay real utilities, bank connections, roommates moving in or out, roommates holding their own keys (Xaman signing links).
