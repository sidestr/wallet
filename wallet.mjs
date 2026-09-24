// The sidestr wallet's logic, with no DOM: open a chain from a mirror, derive a key's address,
// list its coins, build and sign a spend, publish it as a kind 23500 event. Runs in a browser or
// in Node (the test harness): every dependency is an ES module loaded from a URL or a path, and
// the chain is read exactly as the explorer reads it, validating every block. Nothing here talks
// to a producer; a wallet needs a mirror to read and a relay to send to, and nothing else.
export const DEFAULTS = {
  cdn: 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27',
  lib: 'https://cdn.jsdelivr.net/gh/sidestr/spec@722ad42d3271efccfdfaf57c3c6943f58fc168f8/siding/lib',
  explorer: 'https://cdn.jsdelivr.net/gh/sidestr/explorer@0d58ad9dbe33d7245726e54246696f8f3aa2b259/explorer.mjs',
  relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://nostr.oxtr.dev'],
};

// Open by mirror, or by chain id alone: then the relays are asked for the signer's tip
// announcement (kind 33333, d = chain id), which names the mirrors; the one whose chain.json
// names the announcer as signer is taken. Either way the mirror is judged against the announcement.
// `store` ({ get, set, delete } of strings, e.g. localStorage): the explorer keeps its validated state there and a later
// open resumes from it, validating only the blocks since; `fromCache` says the height it resumed from, `verifyFully()` drops it.
export async function openWallet({ mirror, chain, relays = DEFAULTS.relays, cdn = DEFAULTS.cdn, lib = DEFAULTS.lib, explorer = DEFAULTS.explorer, loadJson, store, onProgress = () => {} } = {}) {
  if (!mirror && !chain) throw new Error('a mirror URL or a chain id is needed');
  onProgress('loading the engine');
  const [{ Explorer }, secp, { SIGHASH_UNIFIED }, { makeSigner }, relay, address, announce, nostr, txsign] = await Promise.all([
    import(explorer), import(`${cdn}/codec/secp256k1.js`), import(`${cdn}/codec/interpreter.js`), import(`${lib}/schnorr.mjs`), import(`${lib}/relay.mjs`), import(`${lib}/address.mjs`), import(`${lib}/announce.mjs`), import(`${cdn}/codec/nostr.js`), import(`${lib}/txsign.mjs`)]);
  let announced = null;
  if (!mirror) {
    onProgress(`asking ${relays.length} relay(s) where ${chain} is`);
    const found = await announce.findChain({ relays, chainId: chain, verify: nostr.verifyNostrEvent }); // chain.json is always over the network, like the explorer's
    mirror = found.mirror; announced = found.tip;
  }
  const ex = new Explorer(mirror, { cdn, sidestr: lib, ...(loadJson ? { loadJson } : {}), ...(store ? { store } : {}) });
  onProgress(store ? 'reading the chain from the mirror (from the last visit where possible)' : 'reading the chain from the mirror');
  await ex.open();
  if (chain && ex.chain.id !== chain) throw new Error(`the mirror serves ${ex.chain.id}, not ${chain}`);
  const signer = makeSigner({ hash: ex.hash, secp });
  const w = new Wallet({ ex, signer, secp, events: relay.makeEvents({ signer, hash: ex.hash }), relay, address, announce, nostr, SIGHASH_UNIFIED, txsign, mirror, relays, announced, lib, cdn, loadJson });
  return w;
}

export class Wallet {
  constructor(deps) { Object.assign(this, deps); }
  get chain() { return this.ex.chain; }
  get hrp() { return this.ex.chain.addressPrefix; }
  get tip() { return this.ex.tip(); }
  refresh() { return this.ex.refresh(); }
  get fromCache() { return this.ex.fromCache; } // the height this open resumed from, or null for a full validation
  async verifyFully() { await this.ex.clearCache(); } // the next open validates from genesis again
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
  // the parent's family and network come from the SPEC 3.2 table (loaded with the engine), not from the id's text
  parentExplorer() { const p = this.ex?.parent; if (!p) return null; const host = p.family === 'blake2b' ? 'https://mempool.guide' : 'https://mempool.space'; return p.mainnet ? host : `${host}/testnet4`; }
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
  // the same transaction the reference CLI makes: key-path spends, the parent family's sighash, largest coins first
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
  build({ key, to, amount, fee = null, pegout = false, evmDeposit = false, carrier = null }) {
    const me = this.identity(key); amount = carrier ? 0 : Number(amount);
    if (evmDeposit && !/^0x[0-9a-fA-F]{40}$/.test(String(to).trim())) throw new Error('a deposit goes to a 0x address'); const auto = fee == null || fee === '' || fee === 'auto'; fee = auto ? null : Number(fee);
    if (!Number.isInteger(amount) || amount < 0 || (amount === 0 && !carrier)) throw new Error('the amount is a whole number of sats'); if (!auto && (!Number.isInteger(fee) || fee < 0)) throw new Error('bad fee');
    if (pegout && amount < this.pegoutMin) throw new Error(`a peg-out burns at least ${this.pegoutMin.toLocaleString('en-US')} sats`);
    const dest = carrier ? { script: carrier.script, note: carrier.note ?? null } : evmDeposit ? { script: (this.chain.evm?.reserve ?? this.chain.challenge).toLowerCase(), note: `deposit: ${amount.toLocaleString('en-US')} sats to the reserve, credited as ${amount.toLocaleString('en-US')} gwei to ${String(to).trim()} in the EVM`, extra: this.evmDepositOutputs(String(to).trim(), amount).slice(1) } : pegout ? { script: this.pegoutScript(to), note: `peg-out: ${amount.toLocaleString('en-US')} sats burn on ${this.chain.name} and are owed to ${String(to).trim()} on ${this.chain.parent}; the peg holders pay it there` } : this.resolveTo(to);
    const coins = this.coins(me.script).filter((c) => c.mature).sort((a, b) => b.value - a.value);
    const bound = auto ? Math.ceil(this.minFeeRate * 200) : fee; const picked = []; let sum = 0; for (const c of coins) { picked.push(c); sum += c.value; if (sum >= amount + bound) break; }
    if (sum < amount + bound) throw new Error(`not enough mature coins: ${sum} sats available, ${amount + bound} needed`);
    const lay = (f) => { const change = sum - amount - f; return [{ value: amount, scriptPubKey: dest.script }, ...(dest.extra ?? []), ...(change > 0 ? [{ value: change, scriptPubKey: me.script }] : [])]; };
    const tx = { version: 2, inputs: picked.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: '', sequence: 0xfffffffd })), outputs: lay(auto ? 0 : fee), lockTime: 0, witness: [] };
    if (auto) { fee = Math.ceil(this.vsize({ ...tx, witness: tx.inputs.map(() => ['00'.repeat(65)]) }) * this.minFeeRate); tx.outputs = lay(fee); if (sum - amount - fee < 0) throw new Error(`not enough mature coins for ${amount} sats plus the ${fee}-sat minimum fee`); }
    const change = sum - amount - fee;
    const prevouts = picked.map((c) => ({ value: c.value, scriptPubKey: me.script })); const k = this.ex.k;
    this.txsign.signKeyPath({ k, hash: this.ex.hash, signer: this.signer }, tx, prevouts, key); // the sighash follows the parent's family (SPEC 3)
    return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), inputs: picked, amount, fee, vsize: this.vsize(tx), change, prevouts, note: dest.note };
  }
  // check our own signatures the way a validator would, before anything leaves the machine
  verify({ tx, prevouts }, key) {
    const { pub } = this.identity(key);
    return this.txsign.verifyKeyPath({ k: this.ex.k, hash: this.ex.hash, secp: this.secp }, tx, prevouts, pub);
  }
  // publish as a kind 23500 event from a throwaway key: the transaction authorises itself
  // --- EVM transactions from the page (proposals/evm.md): the same key signs an Ethereum transaction,
  //     which rides inside a sidestr transaction as a carrier (OP_RETURN "evm:" + RLP) paid from my
  //     sats. Every step runs against the page's own validated state first -- a dry run on a
  //     checkpoint that is reverted -- so nothing leaves the machine that a validator would refuse.
  //     No RPC: the carrier goes to the relays like any spend; reads come from the state here. ------
  async #evmLib() { const e = this.evm; if (!e) throw new Error('this chain has no evm rule'); if (!e.ready) await e.init(); if (!this._evmMod) this._evmMod = await import(`${this.lib}/overlays/evm.mjs`); return { e, ...e.lib, mod: this._evmMod }; }
  #addr(a, util) { a = String(a ?? '').trim(); if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`"${a.slice(0, 20)}" is not a 0x address`); return util.createAddressFromString(a.toLowerCase()); }
  #hexb(b) { return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
  #data(d) { d = String(d ?? '').trim().replace(/^0x/i, ''); if (d.length % 2 || !/^[0-9a-f]*$/i.test(d)) throw new Error('data is hex'); return Uint8Array.from(d.match(/../g) ?? [], (x) => parseInt(x, 16)); }
  async evmNonce(address) { const { e, util } = await this.#evmLib(); return (await e.vm.stateManager.getAccount(this.#addr(address, util)))?.nonce ?? 0n; }
  async evmCode(address) { const { e, util } = await this.#evmLib(); return this.#hexb(await e.vm.stateManager.getCode(this.#addr(address, util))); }
  // a call that changes nothing (eth_call; value in gwei): run on a checkpoint, then reverted. { ok, returnValue, gasUsed, error, createdAddress }
  async evmCall({ from = null, to = null, value = 0n, data = '0x', gasLimit = null } = {}) {
    const { e, util, mod, blk } = await this.#evmLib(); await e.vm.stateManager.checkpoint();
    // the call sees the block it would land in: the next height, now — a contract that reads block.timestamp or block.number must not see zeros
    const block = blk.createBlock({ header: { number: BigInt((this.tip?.height ?? 0) + 1), timestamp: BigInt(Math.floor(Date.now() / 1000)), gasLimit: e.gasLimit, coinbase: util.createZeroAddress(), baseFeePerGas: mod.GWEI } }, { common: e.common });
    try { const r = await e.vm.evm.runCall({ block, to: to ? this.#addr(to, util) : undefined, caller: from ? this.#addr(from, util) : util.createZeroAddress(), value: BigInt(value) * mod.GWEI, data: this.#data(data), gasLimit: gasLimit ? BigInt(gasLimit) : e.gasLimit });
      const x = r.execResult.exceptionError; return { ok: !x, error: x ? `${x.error}${r.execResult.returnValue?.length ? ' ' + this.#revertReason(r.execResult.returnValue) : ''}` : null, returnValue: this.#hexb(r.execResult.returnValue ?? new Uint8Array()), gasUsed: r.execResult.executionGasUsed, createdAddress: r.createdAddress ? r.createdAddress.toString() : null }; }
    finally { await e.vm.stateManager.revert(); }
  }
  #revertReason(rv) { const h = this.#hexb(rv); if (h.startsWith('0x08c379a0') && rv.length >= 68) { try { return `"${this.abi.decodeString('0x' + h.slice(10))}"`; } catch {} } return h.length > 2 ? h.slice(0, 20) + '…' : ''; }
  // the producer's estimate, so a page and the RPC agree: intrinsic gas + calldata + execution with a fifth of headroom
  async evmEstimate(call) { const r = await this.evmCall(call); if (!r.ok) throw new Error(`the call reverts: ${r.error}`); const d = this.#data(call.data); const calldata = [...d].reduce((a, b) => a + (b === 0 ? 4 : 16), 0); return 21000n + (call.to ? 0n : 32000n) + BigInt(calldata) + r.gasUsed * 12n / 10n; }
  // sign an Ethereum transaction with my key (value in gwei = sats), carry it in a sidestr transaction from my mature coins, and dry-run the whole thing on this page's state
  async buildEvm({ key, to = null, value = 0, data = '0x', gasLimit = null, nonce = null, fee = null, note = null }) {
    const { e, util, tx: T, mod } = await this.#evmLib(); const priv = util.hexToBytes('0x' + key.toLowerCase()); const from = this.ethAddress(key);
    value = BigInt(value); if (value < 0n) throw new Error('the value is a whole number of gwei'); if (to !== null) this.#addr(to, util); const bytes = this.#data(data); if (to === null && !bytes.length) throw new Error('a deployment needs the contract\'s init code as data');
    const bal = await this.evmBalance(from); if (bal < (value + 21000n) * mod.GWEI) throw new Error(`the EVM balance of ${from.slice(0, 10)}… is ${(bal / mod.GWEI).toLocaleString('en-US')} gwei; ${value.toLocaleString('en-US')} gwei plus gas are needed`);
    const n = nonce == null || nonce === '' ? await this.evmNonce(from) : BigInt(nonce);
    const what = to === null ? `deploy a contract (${bytes.length} bytes of init code)` : value && !bytes.length ? `send ${value.toLocaleString('en-US')} gwei to ${to}` : `call ${to}${value ? ` with ${value.toLocaleString('en-US')} gwei` : ''}`;
    const height = (this.tip?.height ?? 0) + 1, time = Math.floor(Date.now() / 1000);
    // sign, carry and dry-run the real transaction; the gas limit is what the dry run used plus headroom, because a
    // call estimate under-counts what a transaction pays (cold accounts, value transfers, first storage writes)
    const attempt = (gas) => { const etx = T.createLegacyTx({ nonce: n, gasPrice: mod.GWEI, gasLimit: gas, to: to ?? undefined, value: value * mod.GWEI, data: bytes }, { common: e.common }).sign(priv); const rlp = etx.serialize(); const hash = this.#hexb(etx.hash());
      return { gas, hash, b: this.build({ key, fee, carrier: { script: mod.carrierScript(rlp), note: note ?? `${what}: nonce ${n}, gas limit ${gas.toLocaleString('en-US')} at 1 gwei; the Ethereum transaction ${hash.slice(0, 14)}… rides in a sidestr transaction paid from your sats` } }) }; };
    const affordable = bal / mod.GWEI - value; const probe = gasLimit ? BigInt(gasLimit) : (affordable < 3000000n ? affordable : 3000000n); if (probe < 21000n) throw new Error(`the EVM balance of ${from.slice(0, 10)}… cannot pay gas for this`);
    let { gas, hash, b } = attempt(probe); let dry = await e.checkTx(b.tx, b.txid, { height, time }); if (!dry.ok) throw new Error(`a validator would refuse it: ${dry.error}`);
    if (!gasLimit) { const want = dry.gasUsed === 21000n ? 21000n : dry.gasUsed * 5n / 4n + 5000n; /* a plain transfer is exactly 21000; anything that ran code gets headroom */ if (want < probe) { ({ gas, hash, b } = attempt(want)); dry = await e.checkTx(b.tx, b.txid, { height, time }); if (!dry.ok) throw new Error(`a validator would refuse it: ${dry.error}`); } }
    const cost = (value + gas) * mod.GWEI; if (bal < cost) throw new Error(`the EVM balance of ${from.slice(0, 10)}… is ${(bal / mod.GWEI).toLocaleString('en-US')} gwei; ${(cost / mod.GWEI).toLocaleString('en-US')} gwei are needed (value + gas × 1 gwei)`);
    // what the dry run says will happen: gas actually used, and the sender's EVM balance after (value + gas at 1 gwei); unused gas limit is not charged
    const gasUsed = dry.gasUsed ?? gas; const evmAfter = bal - (value + gasUsed) * mod.GWEI;
    return { ...b, ethHash: hash, from, to, value, gasLimit: gas, gasUsed, evmBefore: bal, evmAfter, withdrawal: dry.withdrawals?.[0] ?? null, nonce: n, contractAddress: to === null ? this.#hexb(util.generateAddress(util.hexToBytes(from), util.bigIntToUnpaddedBytes(n))) : null };
  }
  // a withdrawal: value to the WITHDRAW address with my sidestr script as the data; the block's coinbase pays floor(value / 1e9) sats to that script
  async buildWithdraw({ key, sats, fee = null }) { const { mod } = await this.#evmLib(); const me = this.identity(key); sats = Number(sats); if (!Number.isInteger(sats) || sats <= 0) throw new Error('a withdrawal is a whole number of sats'); return this.buildEvm({ key, to: mod.WITHDRAW, value: BigInt(sats), data: '0x' + me.script, fee, note: `withdraw ${sats.toLocaleString('en-US')} gwei from the EVM: the coinbase of the block that carries it pays ${sats.toLocaleString('en-US')} sats to ${me.address}` }); }
  evmReceipt(hash) { return this.evm?.receipts.get(String(hash).toLowerCase()) ?? null; }
  // what this address did or received in the EVM, newest first, as this page has validated it
  evmActivity(address) { const a = String(address).toLowerCase(); const out = []; for (const r of this.evm?.receipts.values() ?? []) if (r.from?.toLowerCase() === a || r.to?.toLowerCase() === a || r.logs?.some(([, topics]) => topics.some((t) => this.#hexb(t).endsWith(a.slice(2))))) out.push(r); return out.sort((x, y) => y.height - x.height); }
  // just enough ABI for ERC-20: the standard selectors as constants (any other is hashed by the EVM's
  // own SHA3 opcode, see keccak()), static words, one dynamic string
  static SELECTORS = { 'name()': '0x06fdde03', 'symbol()': '0x95d89b41', 'decimals()': '0x313ce567', 'totalSupply()': '0x18160ddd', 'balanceOf(address)': '0x70a08231', 'transfer(address,uint256)': '0xa9059cbb', 'approve(address,uint256)': '0x095ea7b3', 'allowance(address,address)': '0xdd62ed3e', 'transferFrom(address,address,uint256)': '0x23b872dd' };
  // keccak-256 by the EVM itself: CALLDATASIZE PUSH0 PUSH0 CALLDATACOPY CALLDATASIZE PUSH0 SHA3 PUSH0 MSTORE PUSH1 32 PUSH0 RETURN
  async keccak(bytes) { const { e } = await this.#evmLib(); const r = await e.vm.evm.runCode({ code: Uint8Array.from([0x36, 0x5f, 0x5f, 0x37, 0x36, 0x5f, 0x20, 0x5f, 0x52, 0x60, 0x20, 0x5f, 0xf3]), data: bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes)), gasLimit: 1000000n }); if (r.exceptionError) throw new Error(`keccak in the EVM: ${r.exceptionError.error}`); return this.#hexb(r.returnValue); }
  async selector(sig) { return Wallet.SELECTORS[sig] ?? (await this.keccak(sig)).slice(0, 10); }
  get abi() {
    if (this._abi) return this._abi; const w = this; const word = (h) => h.replace(/^0x/, '').padStart(64, '0');
    return (this._abi = {
      selector: (sig) => { const x = Wallet.SELECTORS[sig]; if (!x) throw new Error(`no selector known for ${sig}; use await wallet.selector(sig)`); return x; },
      encode: (sig, ...args) => w._abi.selector(sig) + args.map((a) => typeof a === 'bigint' || typeof a === 'number' ? word(BigInt(a).toString(16)) : word(String(a).toLowerCase())).join(''),
      decodeUint: (h) => BigInt(h === '0x' ? 0 : h.slice(0, 66)),
      decodeString: (h) => { const b = w.#data(h); if (b.length === 32) return new TextDecoder().decode(b.subarray(0, b.indexOf(0) < 0 ? 32 : b.indexOf(0))); const off = Number(BigInt('0x' + w.#hexb(b.subarray(0, 32)).slice(2))), len = Number(BigInt('0x' + w.#hexb(b.subarray(off, off + 32)).slice(2))); return new TextDecoder().decode(b.subarray(off + 32, off + 32 + len)); },
    });
  }
  // an ERC-20 as this page's state sees it: { symbol, name, decimals, balance (raw), supply } for one holder
  async token(contract, holder) {
    const { util } = await this.#evmLib(); this.#addr(contract, util); if ((await this.evmCode(contract)) === '0x') throw new Error(`no contract at ${contract}`);
    const call = async (sig, ...args) => { const r = await this.evmCall({ to: contract, data: this.abi.encode(sig, ...args) }); if (!r.ok) throw new Error(`${sig} reverts: ${r.error}`); return r.returnValue; };
    const str = async (sig) => { try { return this.abi.decodeString(await call(sig)); } catch { return null; } };
    const dec = this.abi.decodeUint(await call('decimals()')); const balance = holder ? this.abi.decodeUint(await call('balanceOf(address)', holder)) : null;
    let supply = null; try { supply = this.abi.decodeUint(await call('totalSupply()')); } catch {}
    return { contract: contract.toLowerCase(), symbol: await str('symbol()'), name: await str('name()'), decimals: Number(dec), balance, supply, format: (raw) => { const d = Number(dec); const s = BigInt(raw).toString().padStart(d + 1, '0'); return d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '') || '0' : s; } };
  }
  // amount as a decimal string in the token's units -> raw integer
  tokenAmount(text, decimals) { const m = /^(\d*)(?:\.(\d*))?$/.exec(String(text).trim()); if (!m || (!m[1] && !m[2])) throw new Error('the amount is a decimal number'); const frac = (m[2] ?? '').padEnd(decimals, '0'); if (frac.length > decimals) throw new Error(`at most ${decimals} decimals`); return BigInt((m[1] || '0') + frac); }
  async buildTokenTransfer({ key, contract, to, amount, fee = null }) { const { util } = await this.#evmLib(); this.#addr(to, util); const t = await this.token(contract, this.ethAddress(key)); const raw = this.tokenAmount(amount, t.decimals); if (t.balance < raw) throw new Error(`you hold ${t.format(t.balance)} ${t.symbol ?? 'tokens'}`); return this.buildEvm({ key, to: contract, data: this.abi.encode('transfer(address,uint256)', to, raw), fee, note: `send ${t.format(raw)} ${t.symbol ?? 'tokens'} to ${to}: a call to ${contract}` }); }
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
