// The wallet's logic against the live mirror, with the engine and libraries taken from local
// checkouts rather than the CDN, and the chain's own signer key: builds a real spend, verifies its
// signatures with the curve's verifier, round-trips the hex through the codec. Spends nothing
// unless --send is given, in which case it publishes over the relays and waits for the mirror.
//   node test/wallet-test.mjs [--mirror URL] [--to ADDRESS] [--amount SATS] [--send]
import fs from 'node:fs'; import { homedir } from 'node:os';
import { openWallet, DEFAULTS } from '../wallet.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const H = homedir(), t = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; };
const mirror = args.mirror ?? process.env.SIDESTR_MIRROR; if (!mirror) { console.error('give --mirror URL (or SIDESTR_MIRROR): a mirror serving chain.json, blocks.json, blocks.dat'); process.exit(2); }
const w = await openWallet({ mirror,
  cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${H}/remote/github.com/sidestr/spec/siding/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`,
  loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')), onProgress: (s) => console.log('  … ' + s) });
console.log(`chain ${w.chain.id} at height ${w.tip.height}, ${w.ex.utxo.size} coins on the chain`);
const key = fs.readFileSync(`${H}/.sidestr/${w.chain.name}.key`, 'utf8').trim(); const me = w.identity(key);
t('identity matches the chain signer', me.script === w.chain.challenge && me.address.startsWith(w.hrp + '1'));
const coins = w.coins(me.script), bal = w.balance(me.script);
console.log(`  ${me.address}: ${coins.length} coins, spendable ${bal.spendable}, immature ${bal.immature}`);
t('coins carry maturity', coins.every((c) => typeof c.mature === 'boolean'));
const to = args.to ?? 'ts1pxklu7cthjnc7yvzpelag24p0906sgsxzedlrkd67sv7xtlraupysngzje5', amount = Number(args.amount ?? 1000);
const b = w.build({ key, to, amount });
t(`auto fee is exactly the chain minimum (${b.vsize} vB x ${w.minFeeRate} sat/vB = ${b.fee})`, b.fee === Math.ceil(b.vsize * w.minFeeRate) && b.vsize === w.vsize(b.tx));
t('an explicit fee is honoured', w.build({ key, to, amount, fee: 5000 }).fee === 5000);
console.log(`  built ${b.txid.slice(0, 16)}… ${b.inputs.length} input(s), ${b.amount} + fee ${b.fee}, change ${b.change}`);
t('signatures verify with the curve', w.verify(b, key));
const back = w.ex.k.codec.decode('Transaction', b.hex); t('hex round-trips through the codec', w.ex.k.codec.txid(back) === b.txid && back.outputs[0].value === amount);
t('a tb1p address is accepted with a note', /prefix "tb"/.test(w.resolveTo('tb1pxklu7cthjnc7yvzpelag24p0906sgsxzedlrkd67sv7xtlraupysz3sv9t').note ?? ''));
t('a bad address is refused', (() => { try { w.resolveTo('ts1pnope'); return false; } catch { return true; } })());
t('overspend is refused', (() => { try { w.build({ key, to, amount: 1e15 }); return false; } catch (e) { return /not enough/.test(e.message); } })());
if (args.send) {
  const r = await w.publish(b.hex); console.log('  published', r.event.slice(0, 16) + '…', JSON.stringify(r.results)); t('a relay accepted the event', r.accepted);
  for (let i = 0; i < 18; i++) { await new Promise((res) => setTimeout(res, 10000)); const m = await w.mined(b.txid); if (m) { console.log(`  mined in block ${m.height} (seen on the mirror after ${(i + 1) * 10} s)`); t('mined', true); process.exit(process.exitCode ?? 0); } }
  t('mined within 3 minutes', false);
}
process.exit(process.exitCode ?? 0);
