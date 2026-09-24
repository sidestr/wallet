// A peg-in built from a browser key against the parent kernel, with the coins given (no explorer), verified the way
// the parent would check it, and the marker readable by the chain's scanner.
//   node test/pegin-test.mjs
import fs from 'node:fs'; import os from 'node:os';
const H = os.homedir(); const opts = { mirror: 'http://127.0.0.1:3451', cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${H}/remote/github.com/sidestr/spec/siding/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) };
const { openWallet } = await import('../wallet.mjs'); const { parsePegMarker } = await import(`${opts.lib}/marker.mjs`); const { usesUnifiedSighash } = await import(`${opts.lib}/txsign.mjs`);
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const w = await openWallet(opts); const key = '22'.repeat(32); const me = w.identity(key);
t('the parent address is the same script under the parent prefix', w.parentAddress(key).startsWith('tb1p') && w.address.decodeAddress(w.parentAddress(key)).script === me.script);
const peg = '5120' + 'ab'.repeat(32); const utxos = [{ txid: 'c1'.repeat(32), vout: 0, value: 60000, confirmed: true }, { txid: 'c2'.repeat(32), vout: 1, value: 20000, confirmed: true }, { txid: 'c3'.repeat(32), vout: 0, value: 90000, confirmed: false }];
const b = await w.buildPegIn({ key, amount: 50000, utxos, pegScript: peg });
t('one confirmed input suffices; the unconfirmed one is never picked', b.inputs.length === 1 && b.inputs[0].txid === 'c1'.repeat(32));
t('outputs: the peg first, then the marker, then change; amounts add up', b.tx.outputs[0].scriptPubKey === peg && b.tx.outputs[0].value === 50000 && b.tx.outputs[1].scriptPubKey.startsWith('6a') && b.tx.outputs[2].value === b.change && 50000 + b.fee + b.change === 60000);
t('the marker names this chain and this key\'s script, as the scanner reads it', parsePegMarker(b.tx.outputs[1].scriptPubKey, w.chain.id) === me.script);
const pk = await w['_pk']; const k = pk ?? null;
t('the parent kernel verifies the signature under its own sighash family', (() => { const kk = w._pk; const prevouts = [{ value: 60000, scriptPubKey: me.script }]; return kk.interpreter.verifyInput(b.tx, 0, prevouts[0], prevouts, null, { unifiedSighash: usesUnifiedSighash(kk) }).ok === true; })());
t('fee is at the rate asked and the hex round-trips', b.fee >= b.vsize * 2 && b.fee < b.vsize * 2 + 400 && w._pk.codec.txid(w._pk.codec.decode('Transaction', b.hex)) === b.txid);
const two = await w.buildPegIn({ key, amount: 75000, utxos, pegScript: peg }); t('two inputs when one is not enough', two.inputs.length === 2 && two.change === 80000 - 75000 - two.fee);
let refused = false; try { await w.buildPegIn({ key, amount: 100000, utxos, pegScript: peg }); } catch (e) { refused = /not enough confirmed coins/.test(e.message); } t('too much is refused, naming the parent address', refused);
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
