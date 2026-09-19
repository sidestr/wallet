// The wallet's EVM side against a throwaway evm chain produced by the reference CLI: a deposit,
// a transfer, a contract deployment and a call, an ERC-20 (test/fixtures/Token.sol, compiled with
// solc 0.8.28) read and transferred, a withdrawal paid by the coinbase, the activity list. The
// wallet reads the chain exactly as the page does (the explorer over HTTP) and hands each signed
// transaction to the producer's POST /tx; the relays are not involved.
//   node test/evm-test.mjs            (about 4 minutes: 101 blocks mature the genesis coins)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { openWallet } from '../wallet.mjs';
const H = os.homedir(), SIDING = `${H}/remote/github.com/sidestr/spec/siding`; let ok = 0, bad = 0;
const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const throws = async (name, fn, re) => { try { await fn(); t(name + ' (did not throw)', false); } catch (e) { t(name + (re && !re.test(e.message) ? ` (threw: ${e.message.slice(0, 100)})` : ''), !re || re.test(e.message)); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-evm-')); const port = 3600 + Math.floor(Math.random() * 300); const mirror = `http://127.0.0.1:${port}`;
// the chain: one signer (the test key), 50 genesis coins to it, the evm rule
const { loadEngine } = await import(`${SIDING}/lib/engine.mjs`); const { makeSigner } = await import(`${SIDING}/lib/sign.mjs`);
const base = JSON.parse(fs.readFileSync(`${SIDING}/chain.json`, 'utf8')); const eng0 = await loadEngine(base); const sg = makeSigner(eng0); const key = sg.randomKey(), pub = sg.pubkeyOf(key), me = '5120' + pub;
const chain = { ...base, id: 'sidestr:evmwallet', name: 'evmwallet', addressPrefix: 'ew', challenge: me, signer: pub, rules: ['evm'], evm: { chainId: 21474, gasLimit: 30000000 }, genesisTime: Math.floor(Date.now() / 1000), pegs: [{ txid: 'b'.repeat(64), vout: 0, amount: 5e9, script: me }] }; delete chain.genesisHash;
fs.writeFileSync(`${dir}/chain.json`, JSON.stringify(chain)); fs.writeFileSync(`${dir}/key`, key, { mode: 0o600 });
const prod = spawn(process.execPath, [`${SIDING}/bin/siding.mjs`, 'produce', '--chain', `${dir}/chain.json`, '--dir', `${dir}/data`, '--port', String(port), '--interval', '1', '--tx-interval', '1', '--key-file', `${dir}/key`], { stdio: ['ignore', 'pipe', 'pipe'] });
let plog = ''; prod.stdout.on('data', (d) => { plog += d; }); prod.stderr.on('data', (d) => { plog += d; }); process.on('exit', () => prod.kill());
const status = async () => { try { return await (await fetch(`${mirror}/status.json`)).json(); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`producer on ${mirror}, waiting for the genesis coins to mature (101 blocks at 1 s)…`);
for (let i = 0; i < 400; i++) { const st = await status(); if (st && st.height >= 101) break; await sleep(1000); if (i === 399) { console.error(plog.slice(-2000)); throw new Error('the producer did not reach height 101'); } }
const w = await openWallet({ mirror, cdn: process.env.SCHEMA ?? `${H}/bitcoin-desktop/schema`, lib: `${SIDING}/lib`, explorer: `${H}/remote/github.com/sidestr/explorer/explorer.mjs`, loadJson: async (u) => JSON.parse(fs.readFileSync(u, 'utf8')) });
t('the wallet opened the chain and sees the evm rule', !!w.evm && w.chain.id === 'sidestr:evmwallet');
const id = w.identity(key); t('the genesis coins are mature and spendable', w.balance(id.script).spendable === 5e9);
const eth = w.ethAddress(key); t('the same key is an Ethereum address', /^0x[0-9a-f]{40}$/.test(eth));
// hand a signed transaction to the producer and wait for the wallet to see it mined
const deliver = async (b) => { const r = await fetch(`${mirror}/tx`, { method: 'POST', body: b.hex }); const j = await r.json(); if (!r.ok) throw new Error(`producer refused: ${j.error}`); for (let i = 0; i < 40; i++) { await sleep(500); const m = await w.mined(b.txid); if (m) return m; } throw new Error(`${b.txid.slice(0, 12)}… not mined in 20 s\n${plog.slice(-1500)}`); };
// 1. deposit
const dep = w.build({ key, to: eth, amount: 5000000, evmDeposit: true }); t('a deposit builds: reserve payment then the evmin marker', dep.tx.outputs[0].scriptPubKey === w.chain.challenge && dep.tx.outputs[1].scriptPubKey.startsWith('6a1a65766d696e3a'));
await deliver(dep); t('5,000,000 sats deposited = 5,000,000 gwei in the page\'s own state', (await w.evmBalance(eth)) === 5000000n * 1000000000n);
// 2. a transfer, carried
const bob = '0x' + '77'.repeat(20);
await throws('a transfer beyond the balance is refused before anything is signed', () => w.buildEvm({ key, to: bob, value: 6000000 }), /EVM balance/);
await throws('a bad address is refused', () => w.buildEvm({ key, to: '0x1234', value: 1 }), /not a 0x address/);
const x = await w.buildEvm({ key, to: bob, value: 250000 }); t('a transfer builds: nonce 0, gas 21000, a carrier output, a sats fee', x.nonce === 0n && x.gasLimit === 21000n && x.tx.outputs[0].value === 0 && x.tx.outputs[0].scriptPubKey.includes('65766d3a') && x.fee > 0 && x.amount === 0);
t('the sidestr signature verifies', w.verify(x, key));
t('the build reports what the dry run says will happen: gas used and the EVM balance after', x.gasUsed === 21000n && x.evmBefore === 5000000n * 1000000000n && x.evmAfter === (5000000n - 250000n - 21000n) * 1000000000n);
const m2 = await deliver(x); const rc = w.evmReceipt(x.ethHash); t('mined: the receipt is in the page\'s state with status 1 and the block height', rc?.status === 1 && rc.height === m2.height && rc.sidechainTxid === x.txid);
t('bob has 250,000 gwei; I paid 21,000 gwei of gas', (await w.evmBalance(bob)) === 250000n * 1000000000n && (await w.evmBalance(eth)) === (5000000n - 250000n - 21000n) * 1000000000n);
await throws('a stale nonce is refused by the dry run (a validator would refuse it)', () => w.buildEvm({ key, to: bob, value: 1, nonce: 0 }), /validator would refuse/);
// 3. a contract: runtime that returns 42
const runtime = '602a60005260206000f3', init = '69' + runtime + '600052600a6016f3';
const d = await w.buildEvm({ key, data: init }); t('a deployment builds with a predicted contract address', d.to === null && /^0x[0-9a-f]{40}$/.test(d.contractAddress) && d.gasLimit > 53000n);
await deliver(d); t('the contract is at the predicted address with its runtime code', (await w.evmCode(d.contractAddress)) === '0x' + runtime && w.evmReceipt(d.ethHash)?.contractAddress === d.contractAddress);
const c = await w.evmCall({ to: d.contractAddress }); t('a call (eth_call) answers 42 without changing anything', c.ok && BigInt(c.returnValue) === 42n);
// a contract that returns block.timestamp: a read-only call must see a real clock, not zero (the faucet bug of 19 Sep)
const tsRuntime = '425f5260205ff3', tsInit = '66' + tsRuntime + '5f5260076019f3'; const dt0 = await w.buildEvm({ key, data: tsInit }); await deliver(dt0);
const ts = await w.evmCall({ to: dt0.contractAddress }); t('a read-only call sees the block it would land in: block.timestamp is now, not zero', ts.ok && Math.abs(Number(BigInt(ts.returnValue)) - Date.now() / 1000) < 120);
// 4. an ERC-20: Token(name, symbol, decimals, supply) from test/fixtures
const bin = fs.readFileSync(new URL('./fixtures/Token.bin', import.meta.url), 'utf8').trim(); const word = (h) => h.replace(/^0x/, '').padStart(64, '0'); const str = (s) => { const b = Buffer.from(s); return word(b.length.toString(16)) + b.toString('hex').padEnd(64, '0'); };
const ctor = word('80') + word('c0') + word('2') + word((100000000n).toString(16)) + str('Shell Token') + str('SHELL'); // two dynamic strings at offsets 0x80 and 0xc0
const dt = await w.buildEvm({ key, data: bin + ctor }); await deliver(dt);
const tok = await w.token(dt.contractAddress, eth); t('the token reads back: SHELL, 2 decimals, the deployer holds the supply', tok.symbol === 'SHELL' && tok.name === 'Shell Token' && tok.decimals === 2 && tok.balance === 100000000n && tok.supply === 100000000n && tok.format(tok.balance) === '1000000');
t('a token amount parses in the token\'s units', w.tokenAmount('12.5', 2) === 1250n && w.tokenAmount('7', 2) === 700n);
await throws('a token transfer beyond the holding is refused', () => w.buildTokenTransfer({ key, contract: dt.contractAddress, to: bob, amount: '2000000' }), /you hold/);
const tt = await w.buildTokenTransfer({ key, contract: dt.contractAddress, to: bob, amount: '12.5' }); await deliver(tt);
const tb = await w.token(dt.contractAddress, bob); t('bob holds 12.5 SHELL after the transfer, with a Transfer log in the receipt', tb.balance === 1250n && (w.evmReceipt(tt.ethHash)?.logs.length === 1));
t('an ERC-20 selector is the standard constant; any other signature is hashed by the EVM itself', (await w.selector('transfer(address,uint256)')) === '0xa9059cbb' && (await w.selector('balanceOf(address)')) === '0x70a08231' && (await w.keccak(new Uint8Array())) === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
const rev = await w.evmCall({ to: dt.contractAddress, data: w.abi.encode('transfer(address,uint256)', bob, 10n ** 30n) }); t('a reverting call reports the revert reason', !rev.ok && /balance/.test(rev.error));
// 5. a withdrawal: 100,000 gwei -> the coinbase pays 100,000 sats to my script
const before = w.balance(id.script).total; const wd = await w.buildWithdraw({ key, sats: 100000 }); t('a withdrawal builds: to WITHDRAW with my 34-byte script as data', wd.to === '0x00000000000000000000000000000000000501de' && wd.value === 100000n);
const m5 = await deliver(wd); const paid = w.coins(id.script).find((c) => c.coinbase && c.height === m5.height && c.value === 100000);
t('the block\'s coinbase paid 100,000 sats to my script (immature, like any coinbase output)', !!paid && !paid.mature && w.evmReceipt(wd.ethHash)?.status === 1);
// 6. activity
const act = w.evmActivity(eth); t('the activity list has my five Ethereum transactions, newest first', act.length === 5 && act[0].transactionHash === wd.ethHash && act[4].transactionHash === x.ethHash);
t('the activity list of bob shows the transfer and the token transfer (by its log)', w.evmActivity(bob).length === 2);
prod.kill(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
