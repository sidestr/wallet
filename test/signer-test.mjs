// A spend built unsigned for a browser signer (proposals/browser-signer.md) and signed by a stand-in for one: the same
// txsign path an extension runs, over coins given here (no spend reaches the chain). Checks what signWith holds the
// signer to: the txid that was built, and every signature under the chain's own sighash, or nothing is returned.
//   SIDESTR_MIRROR=<mirror URL> node test/signer-test.mjs
import fs from 'node:fs'; import os from 'node:os';
const H = os.homedir(); const opts = { mirror: process.env.SIDESTR_MIRROR ?? 'http://127.0.0.1:3451', cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: process.env.SIDESTR_LIB ?? `${H}/remote/github.com/sidestr/spec/siding/lib`, explorer: process.env.SIDESTR_EXPLORER ?? `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) };
const { openWallet, browserSigner } = await import('../wallet.mjs');
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message) || re.test(e.code ?? ''); } };
const w = await openWallet(opts); const key = '33'.repeat(32), other = '44'.repeat(32); const me = w.identity(key);
// two coins of this key that the chain need not have: the builder and the stand-in signer read the same list
const coins = [{ outpoint: `${'d1'.repeat(32)}:0`, txid: 'd1'.repeat(32), vout: 0, value: 40000, height: 1, coinbase: false, mature: true }, { outpoint: `${'d2'.repeat(32)}:1`, txid: 'd2'.repeat(32), vout: 1, value: 25000, height: 2, coinbase: false, mature: true }];
w.coins = (script) => (script === me.script ? coins : []);
// a browser signer as the proposal has it: decodes the hex, finds each input among its own coins, signs with its key
const signerWith = (k, tamper = null) => ({ version: 1, async signTransaction({ chain, tx }) {
  if (chain !== w.chain.id) throw Object.assign(new Error('not this chain'), { code: 'unsupported' });
  const d = w.ex.k.codec.decode('Transaction', tx); const prevouts = d.inputs.map((i) => { const c = coins.find((x) => x.txid === i.prevout.txid && x.vout === i.prevout.vout); if (!c) throw Object.assign(new Error('not mine'), { code: 'not-yours' }); return { value: c.value, scriptPubKey: me.script }; });
  w.txsign.signKeyPath({ k: w.ex.k, hash: w.ex.hash, signer: w.signer }, d, prevouts, k); if (tamper) tamper(d);
  return { tx: w.ex.k.codec.encodeHex('Transaction', d), txid: w.ex.k.codec.txid(d) }; } });

t('identityOf(pub) is identity(key) without the key', JSON.stringify(w.identityOf(me.pub)) === JSON.stringify(me));
t('no window.nostr.sidestr here, so no browser signer', browserSigner() === null);
const to = w.address.scriptToAddress('5120' + 'ab'.repeat(32), w.hrp);
const u = w.build({ pub: me.pub, to, amount: 30000 }), s = w.build({ key, to, amount: 30000 });
t('an unsigned build carries no witness and says so', u.unsigned === true && u.tx.witness.length === 0 && !w.ex.k.codec.decode('Transaction', u.hex).witness?.some((x) => x?.length));
t('unsigned and signed builds are the same transaction: txid, fee, size, change', u.txid === s.txid && u.fee === s.fee && u.vsize === s.vsize && u.change === s.change);
const signed = await w.signWith(signerWith(key), u);
t('signWith takes a good signer: same txid, signatures that verify, now signed', signed.txid === u.txid && !signed.unsigned && w.verify(signed, key) && signed.tx.witness.length === u.tx.inputs.length); // BIP 340 aux randomness: the witness bytes differ from s, the transaction does not
t('a signer that returns another transaction is refused', await rejects(w.signWith(signerWith(key, (d) => { d.outputs[0].value -= 1; }), u), /different transaction/));
t('a signer that signs with another key is refused', await rejects(w.signWith(signerWith(other), u), /did not verify/));
t('a signer that answers with no transaction is refused', await rejects(w.signWith({ version: 1, signTransaction: async () => ({ tx: 'zz' }) }, u), /not a transaction/));
t('a refusal comes through with its code', await rejects(w.signWith({ version: 1, signTransaction: async () => { throw Object.assign(new Error('the person said no'), { code: 'rejected' }); } }, u), /^rejected$/));
t('no signer at all is refused', await rejects(w.signWith(null, u), /no browser signer/));
globalThis.nostr = { sidestr: signerWith(key) }; t('window.nostr.sidestr at version 1 is found', browserSigner() === globalThis.nostr.sidestr); delete globalThis.nostr;
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
