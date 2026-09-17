// The sidestr wallet's logic, with no DOM: open a chain from a mirror, derive a key's address,
// list its coins, build and sign a spend, publish it as a kind 23500 event. Runs in a browser or
// in Node (the test harness): every dependency is an ES module loaded from a URL or a path, and
// the chain is read exactly as the explorer reads it, validating every block. Nothing here talks
// to a producer; a wallet needs a mirror to read and a relay to send to, and nothing else.
export const DEFAULTS = {
  cdn: 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27',
  lib: 'https://cdn.jsdelivr.net/gh/sidestr/spec@36d2ee841f17810faad3cdaee6f0e0bd046c56ce/siding/lib',
  explorer: 'https://cdn.jsdelivr.net/gh/sidestr/explorer@67b975b1233092bf4f5ff10f9e62e22936c71275/explorer.mjs',
  relays: ['wss://nos.lol', 'wss://relay.damus.io'],
  fee: 1000,
};

export async function openWallet({ mirror, cdn = DEFAULTS.cdn, lib = DEFAULTS.lib, explorer = DEFAULTS.explorer, loadJson, onProgress = () => {} } = {}) {
  if (!mirror) throw new Error('a mirror URL is needed');
  onProgress('loading the engine');
  const [{ Explorer }, secp, { SIGHASH_UNIFIED }, { makeSigner }, relay, address] = await Promise.all([
    import(explorer), import(`${cdn}/codec/secp256k1.js`), import(`${cdn}/codec/interpreter.js`), import(`${lib}/schnorr.mjs`), import(`${lib}/relay.mjs`), import(`${lib}/address.mjs`)]);
  const ex = new Explorer(mirror, { cdn, sidestr: lib, ...(loadJson ? { loadJson } : {}) });
  onProgress('reading the chain from the mirror');
  await ex.open();
  const signer = makeSigner({ hash: ex.hash, secp });
  return new Wallet({ ex, signer, secp, events: relay.makeEvents({ signer, hash: ex.hash }), relay, address, SIGHASH_UNIFIED });
}

export class Wallet {
  constructor(deps) { Object.assign(this, deps); }
  get chain() { return this.ex.chain; }
  get hrp() { return this.ex.chain.addressPrefix; }
  get tip() { return this.ex.tip(); }
  refresh() { return this.ex.refresh(); }
  newKey() { return this.signer.randomKey(); }
  identity(key) { if (!/^[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('a key is 32 bytes of hex'); const pub = this.signer.pubkeyOf(key.toLowerCase()); const script = '5120' + pub; return { pub, script, address: this.address.scriptToAddress(script, this.hrp) }; }
  coins(script) {
    const tip = this.tip?.height ?? 0, maturity = this.ex.k.params.coinbaseMaturity; const out = [];
    for (const [key, c] of this.ex.utxo) if (c.output.scriptPubKey === script) out.push({ outpoint: key, txid: c.outpoint.txid, vout: c.outpoint.vout, value: c.output.value, height: c.height, coinbase: c.coinbase, mature: !c.coinbase || tip + 1 - c.height >= maturity, maturesAt: c.coinbase ? c.height + maturity - 1 : null });
    return out.sort((a, b) => a.height - b.height || a.vout - b.vout);
  }
  balance(script) { let spendable = 0, immature = 0; for (const c of this.coins(script)) { if (c.mature) spendable += c.value; else immature += c.value; } return { spendable, immature, total: spendable + immature }; }
  history(script) { const a = this.ex.byScript.get(script); return [...(a?.outputs ?? []).map((o) => ({ ...o, dir: 'in' })), ...(a?.spends ?? []).map((s) => ({ ...s, dir: 'out' }))].sort((x, y) => y.height - x.height); }
  // a destination is a script hex or a segwit address under any prefix: the script is what is paid
  resolveTo(to) {
    to = String(to ?? '').trim(); if (/^[0-9a-f]+$/i.test(to)) return { script: to.toLowerCase(), note: null };
    const a = this.address.decodeAddress(to); if (!a) throw new Error(`"${to}" is not an address or a script`);
    return { script: a.script, note: a.hrp === this.hrp ? null : `that address carries the prefix "${a.hrp}"; on this chain the same script is ${this.address.scriptToAddress(a.script, this.hrp)}. Its script is what is paid.` };
  }
  // the same transaction the reference CLI makes: key-path spends, unified sighash, largest coins first
  build({ key, to, amount, fee = DEFAULTS.fee }) {
    const me = this.identity(key), dest = this.resolveTo(to); amount = Number(amount); fee = Number(fee);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('the amount is a whole number of sats'); if (!Number.isInteger(fee) || fee < 0) throw new Error('bad fee');
    const coins = this.coins(me.script).filter((c) => c.mature).sort((a, b) => b.value - a.value);
    const picked = []; let sum = 0; for (const c of coins) { picked.push(c); sum += c.value; if (sum >= amount + fee) break; }
    if (sum < amount + fee) throw new Error(`not enough mature coins: ${sum} sats available, ${amount + fee} needed`);
    const change = sum - amount - fee;
    const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: '', sequence: 0xfffffffd })),
      outputs: [{ value: amount, scriptPubKey: dest.script }, ...(change > 0 ? [{ value: change, scriptPubKey: me.script }] : [])], lockTime: 0, witness: [] };
    const prevouts = picked.map((c) => ({ value: c.value, scriptPubKey: me.script })); const ht = 0x01 | this.SIGHASH_UNIFIED, k = this.ex.k, h = this.ex.hash;
    tx.witness = tx.inputs.map((_, i) => { let m = k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = h.hexToBytes(m); return [h.bytesToHex(this.signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]; });
    return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), inputs: picked, amount, fee, change, prevouts, note: dest.note };
  }
  // check our own signatures the way a validator would, before anything leaves the machine
  verify({ tx, prevouts }, key) {
    const { pub } = this.identity(key), ht = 0x01 | this.SIGHASH_UNIFIED, k = this.ex.k, h = this.ex.hash;
    return tx.inputs.every((_, i) => { let m = k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = h.hexToBytes(m); const w = tx.witness[i][0]; return w.endsWith(ht.toString(16).padStart(2, '0')) && this.secp.verifySchnorr(m, h.hexToBytes(w.slice(0, 128)), h.hexToBytes(pub)); });
  }
  // publish as a kind 23500 event from a throwaway key: the transaction authorises itself
  async publish(hex, relays = DEFAULTS.relays) { const ev = this.events.txEvent(this.signer.randomKey(), this.chain.id, hex); const results = await this.relay.publish({ relays, event: ev }); return { event: ev.id, results, accepted: Object.values(results).some((r) => r === 'ok') }; }
  // has a transaction been mined, as far as the mirror knows
  async mined(txid) { await this.refresh(); const t = this.ex.txs.get(txid); return t ? { height: t.height } : null; }
}
