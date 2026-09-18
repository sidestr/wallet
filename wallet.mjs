// The sidestr wallet's logic, with no DOM: open a chain from a mirror, derive a key's address,
// list its coins, build and sign a spend, publish it as a kind 23500 event. Runs in a browser or
// in Node (the test harness): every dependency is an ES module loaded from a URL or a path, and
// the chain is read exactly as the explorer reads it, validating every block. Nothing here talks
// to a producer; a wallet needs a mirror to read and a relay to send to, and nothing else.
export const DEFAULTS = {
  cdn: 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27',
  lib: 'https://cdn.jsdelivr.net/gh/sidestr/spec@244535b4321a8cff498a0897a8b961f65ab3ecd2/siding/lib',
  explorer: 'https://cdn.jsdelivr.net/gh/sidestr/explorer@c8bc1a084c34a26066adeb821a2baa4bbf1209d5/explorer.mjs',
  relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'],
};

// Open by mirror, or by chain id alone: then the relays are asked for the signer's tip
// announcement (kind 33333, d = chain id), which names the mirrors; the one whose chain.json
// names the announcer as signer is taken. Either way the mirror is judged against the announcement.
export async function openWallet({ mirror, chain, relays = DEFAULTS.relays, cdn = DEFAULTS.cdn, lib = DEFAULTS.lib, explorer = DEFAULTS.explorer, loadJson, onProgress = () => {} } = {}) {
  if (!mirror && !chain) throw new Error('a mirror URL or a chain id is needed');
  onProgress('loading the engine');
  const [{ Explorer }, secp, { SIGHASH_UNIFIED }, { makeSigner }, relay, address, announce, nostr] = await Promise.all([
    import(explorer), import(`${cdn}/codec/secp256k1.js`), import(`${cdn}/codec/interpreter.js`), import(`${lib}/schnorr.mjs`), import(`${lib}/relay.mjs`), import(`${lib}/address.mjs`), import(`${lib}/announce.mjs`), import(`${cdn}/codec/nostr.js`)]);
  let announced = null;
  if (!mirror) {
    onProgress(`asking ${relays.length} relay(s) where ${chain} is`);
    const found = await announce.findChain({ relays, chainId: chain, verify: nostr.verifyNostrEvent }); // chain.json is always over the network, like the explorer's
    mirror = found.mirror; announced = found.tip;
  }
  const ex = new Explorer(mirror, { cdn, sidestr: lib, ...(loadJson ? { loadJson } : {}) });
  onProgress('reading the chain from the mirror');
  await ex.open();
  if (chain && ex.chain.id !== chain) throw new Error(`the mirror serves ${ex.chain.id}, not ${chain}`);
  const signer = makeSigner({ hash: ex.hash, secp });
  const w = new Wallet({ ex, signer, secp, events: relay.makeEvents({ signer, hash: ex.hash }), relay, address, announce, nostr, SIGHASH_UNIFIED, mirror, relays, announced, lib, cdn, loadJson });
  return w;
}

export class Wallet {
  constructor(deps) { Object.assign(this, deps); }
  get chain() { return this.ex.chain; }
  get hrp() { return this.ex.chain.addressPrefix; }
  get tip() { return this.ex.tip(); }
  refresh() { return this.ex.refresh(); }
  // the mirror against the signer's latest announcement: { ok: true | false | null, note }
  async judgeMirror() {
    if (!this.announced) this.announced = await this.announce.fetchLatestTip({ relays: this.relays, chainId: this.chain.id, verify: this.nostr.verifyNostrEvent, signer: this.chain.signer });
    const tip = this.tip; return this.announce.judgeMirror({ announced: this.announced, height: tip.height, headerHex: this.ex.headerHex(tip.height) });
  }
  // the signer's announcements as they come: onTip({ tip, ... }) for each newer one; returns { close() }
  followTips(onTip, relays = this.relays) {
    return this.relay.subscribe({ relays, chainId: this.chain.id, verify: this.nostr.verifyNostrEvent, kind: this.announce.TIP_KIND, tag: 'd', since: 60, onEvent: (ev) => {
      const t = this.announce.parseTip(ev); if (!t || t.pubkey !== this.chain.signer || (this.announced && t.tip <= this.announced.tip)) return; this.announced = t; onTip(t);
    } });
  }
  newKey() { return this.signer.randomKey(); }
  identity(key) { if (!/^[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('a key is 32 bytes of hex'); const pub = this.signer.pubkeyOf(key.toLowerCase()); const script = '5120' + pub; return { pub, script, address: this.address.scriptToAddress(script, this.hrp) }; }
  coins(script) {
    const tip = this.tip?.height ?? 0, maturity = this.ex.k.params.coinbaseMaturity; const out = [];
    for (const [key, c] of this.ex.utxo) if (c.output.scriptPubKey === script) out.push({ outpoint: key, txid: c.outpoint.txid, vout: c.outpoint.vout, value: c.output.value, height: c.height, coinbase: c.coinbase, mature: !c.coinbase || tip + 1 - c.height >= maturity, maturesAt: c.coinbase ? c.height + maturity - 1 : null });
    return out.sort((a, b) => a.height - b.height || a.vout - b.vout);
  }
  balance(script) { let spendable = 0, immature = 0; for (const c of this.coins(script)) { if (c.mature) spendable += c.value; else immature += c.value; } return { spendable, immature, total: spendable + immature }; }
  // where the parent's coins can be seen (a public explorer per parent network)
  parentExplorer() { const p = this.chain.parent ?? ''; if (/testnet4/.test(p)) return 'https://mempool.guide/testnet4'; if (/mainnet/.test(p)) return 'https://mempool.guide'; return null; }
  parentTxUrl(txid) { const b = this.parentExplorer(); return b ? `${b}/tx/${txid}` : null; }
  parentAddressUrl(address) { const b = this.parentExplorer(); return b ? `${b}/address/${address}` : null; }
  // the mirror's record of paid burns: `${txid}:${vout}` -> { parentTxid, address, value, ... }
  async pegoutsPaid() { try { const r = await fetch(`${this.mirror}/pegouts.json`, { cache: 'no-store' }); return r.ok ? (await r.json()).paid ?? {} : {}; } catch { return {}; } }
  history(script) { const a = this.ex.byScript.get(script); return [...(a?.outputs ?? []).map((o) => ({ ...o, dir: 'in' })), ...(a?.spends ?? []).map((s) => ({ ...s, dir: 'out' }))].sort((x, y) => y.height - x.height); }
  // a destination is a script hex or a segwit address under any prefix: the script is what is paid
  resolveTo(to) {
    to = String(to ?? '').trim(); if (/^[0-9a-f]+$/i.test(to)) return { script: to.toLowerCase(), note: null };
    const a = this.address.decodeAddress(to); if (!a) throw new Error(`"${to}" is not an address or a script`);
    return { script: a.script, note: a.hrp === this.hrp ? null : `that address carries the prefix "${a.hrp}"; on this chain the same script is ${this.address.scriptToAddress(a.script, this.hrp)}. Its script is what is paid.` };
  }
  // the same transaction the reference CLI makes: key-path spends, unified sighash, largest coins first
  get minFeeRate() { return Number(this.chain.minFeeRate ?? 1); } // sat/vB, the producer's policy, from chain.json
  vsize(tx) { return Math.ceil(this.ex.k.codec.txWeight(tx) / 4); }
  // fee null: exactly the chain's minimum for this transaction's size (key-path witnesses are 65 bytes, known before signing)
  get pegoutMin() { return Number(this.chain.pegoutMin ?? 10000); }
  // --- the evm rule (proposals/evm.md): the same key is an Ethereum key; 1 sat = 1 gwei ---------
  get evm() { return this.ex.rules?.evm ?? null; }
  ethAddress(key) { const u = this.evm?.lib?.util; if (!u) return null; return u.createAddressFromPrivateKey(u.hexToBytes('0x' + key)).toString(); }
  async evmBalance(address) { const e = this.evm; if (!e) return 0n; const a = await e.vm.stateManager.getAccount(e.lib.util.createAddressFromString(address)); return a?.balance ?? 0n; }
  // the deposit output pair: the reserve payment, then the marker naming the address
  evmDepositOutputs(address, amount) { const enc = new TextEncoder(); const b = new Uint8Array([...enc.encode('evmin:'), ...Uint8Array.from(address.slice(2).match(/../g), (x) => parseInt(x, 16))]); return [{ value: amount, scriptPubKey: (this.chain.evm?.reserve ?? this.chain.challenge).toLowerCase() }, { value: 0, scriptPubKey: '6a' + b.length.toString(16).padStart(2, '0') + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') }]; }
  // the burn output for a parent address or script (SPEC 7): OP_RETURN `pegout:<script>`
  pegoutScript(to) { const enc = new TextEncoder().encode(`pegout:${this.resolveTo(to).script}`); return '6a' + enc.length.toString(16).padStart(2, '0') + Array.from(enc, (b) => b.toString(16).padStart(2, '0')).join(''); }
  // pegout: `to` is a parent address; the amount burns here and the peg holders owe it there
  build({ key, to, amount, fee = null, pegout = false, evmDeposit = false }) {
    const me = this.identity(key); amount = Number(amount);
    if (evmDeposit && !/^0x[0-9a-fA-F]{40}$/.test(String(to).trim())) throw new Error('a deposit goes to a 0x address'); const auto = fee == null || fee === '' || fee === 'auto'; fee = auto ? null : Number(fee);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('the amount is a whole number of sats'); if (!auto && (!Number.isInteger(fee) || fee < 0)) throw new Error('bad fee');
    if (pegout && amount < this.pegoutMin) throw new Error(`a peg-out burns at least ${this.pegoutMin.toLocaleString('en-US')} sats`);
    const dest = evmDeposit ? { script: (this.chain.evm?.reserve ?? this.chain.challenge).toLowerCase(), note: `deposit: ${amount.toLocaleString('en-US')} sats to the reserve, credited as ${amount.toLocaleString('en-US')} gwei to ${String(to).trim()} in the EVM`, extra: this.evmDepositOutputs(String(to).trim(), amount).slice(1) } : pegout ? { script: this.pegoutScript(to), note: `peg-out: ${amount.toLocaleString('en-US')} sats burn on ${this.chain.name} and are owed to ${String(to).trim()} on ${this.chain.parent}; the peg holders pay it there` } : this.resolveTo(to);
    const coins = this.coins(me.script).filter((c) => c.mature).sort((a, b) => b.value - a.value);
    const bound = auto ? Math.ceil(this.minFeeRate * 200) : fee; const picked = []; let sum = 0; for (const c of coins) { picked.push(c); sum += c.value; if (sum >= amount + bound) break; }
    if (sum < amount + bound) throw new Error(`not enough mature coins: ${sum} sats available, ${amount + bound} needed`);
    const lay = (f) => { const change = sum - amount - f; return [{ value: amount, scriptPubKey: dest.script }, ...(dest.extra ?? []), ...(change > 0 ? [{ value: change, scriptPubKey: me.script }] : [])]; };
    const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: '', sequence: 0xfffffffd })), outputs: lay(auto ? 0 : fee), lockTime: 0, witness: [] };
    if (auto) { fee = Math.ceil(this.vsize({ ...tx, witness: tx.inputs.map(() => ['00'.repeat(65)]) }) * this.minFeeRate); tx.outputs = lay(fee); if (sum - amount - fee < 0) throw new Error(`not enough mature coins for ${amount} sats plus the ${fee}-sat minimum fee`); }
    const change = sum - amount - fee;
    const prevouts = picked.map((c) => ({ value: c.value, scriptPubKey: me.script })); const ht = 0x01 | this.SIGHASH_UNIFIED, k = this.ex.k, h = this.ex.hash;
    tx.witness = tx.inputs.map((_, i) => { let m = k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = h.hexToBytes(m); return [h.bytesToHex(this.signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]; });
    return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), inputs: picked, amount, fee, vsize: this.vsize(tx), change, prevouts, note: dest.note };
  }
  // check our own signatures the way a validator would, before anything leaves the machine
  verify({ tx, prevouts }, key) {
    const { pub } = this.identity(key), ht = 0x01 | this.SIGHASH_UNIFIED, k = this.ex.k, h = this.ex.hash;
    return tx.inputs.every((_, i) => { let m = k.interpreter.sighashUnified(tx, i, prevouts, ht, 2); if (typeof m === 'string') m = h.hexToBytes(m); const w = tx.witness[i][0]; return w.endsWith(ht.toString(16).padStart(2, '0')) && this.secp.verifySchnorr(m, h.hexToBytes(w.slice(0, 128)), h.hexToBytes(pub)); });
  }
  // publish as a kind 23500 event from a throwaway key: the transaction authorises itself
  // --- the desk (SPEC 6.2): locked parent rewards pledged for sats now ---------------------
  get desk() { return this.chain.pledge ?? null; }
  // my locked rewards as the desk has seen them, with whether each is pledged already
  async lockedRewards(script) {
    if (!this.desk) return []; const [cb, pl] = await Promise.all([fetch(`${this.mirror}/coinbases.json`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : { coinbases: [] }).catch(() => ({ coinbases: [] })), fetch(`${this.mirror}/pledges.json`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : { pledges: {} }).catch(() => ({ pledges: {} }))]);
    return (cb.coinbases ?? []).filter((c) => c.script === script).map((c) => ({ ...c, pledged: pl.pledges?.[`${c.txid}:${c.vout}`] ?? null, maturity: c.height >= this.desk.lockedFrom ? this.desk.maturity : c.height + 100, pays: Math.floor(c.value * this.desk.rate) }));
  }
  async #parentKernel() { if (!this._pk) { const { parentKernel } = await import(`${this.lib}/pledge.mjs`); this._pk = await parentKernel({ cdn: this.cdn, parent: this.chain.parent, ...(this.loadJson ? { loadJson: this.loadJson } : {}) }); } return this._pk; }
  // sign the maturity transaction for one reward with my key (the payee is me) and publish it as kind 33502
  async pledge({ key, reward, relays = this.relays }) {
    const { buildPledge, PLEDGE_KIND } = await import(`${this.lib}/pledge.mjs`); const k = await this.#parentKernel(); const me = this.identity(key);
    const b = buildPledge({ k, hash: this.ex.hash, signer: this.signer, SIGHASH_UNIFIED: this.SIGHASH_UNIFIED, key, chain: this.chain, reward, payeeScript: me.script });
    return this.publishPledge({ hex: b.hex, outpoint: `${reward.txid}:${reward.vout}`, relays, pays: b.pays, lockTime: b.lockTime });
  }
  // a pledge signed elsewhere (a node wallet, say): checked for shape here, then published
  async publishPledge({ hex, outpoint, relays = this.relays, pays = null, lockTime = null }) {
    const { PLEDGE_KIND } = await import(`${this.lib}/pledge.mjs`); hex = String(hex).trim(); if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('a transaction is hex');
    const ev = this.events.signEvent(this.signer.randomKey(), { kind: PLEDGE_KIND, tags: [['d', outpoint], ['chain', this.chain.id]], content: hex.toLowerCase() });
    const results = await this.relay.publish({ relays, event: ev }); return { event: ev.id, results, accepted: Object.values(results).some((r) => r === 'ok'), pays, lockTime };
  }
  async publish(hex, relays = DEFAULTS.relays) { const ev = this.events.txEvent(this.signer.randomKey(), this.chain.id, hex); const results = await this.relay.publish({ relays, event: ev }); return { event: ev.id, results, accepted: Object.values(results).some((r) => r === 'ok') }; }
  // ask a faucet for coins (SPEC 11, kind 23501): the request carries the address; a faucet on the relay answers with a payment
  async requestFaucet(address, relays = DEFAULTS.relays) { const ev = this.events.signEvent(this.signer.randomKey(), { kind: 23501, tags: [['chain', this.chain.id]], content: address }); const results = await this.relay.publish({ relays, event: ev }); return { event: ev.id, results, accepted: Object.values(results).some((r) => r === 'ok') }; }
  // has a transaction been mined, as far as the mirror knows
  async mined(txid) { await this.refresh(); const t = this.ex.txs.get(txid); return t ? { height: t.height } : null; }
}
